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
 * fine"; it is "a thirteenth cannot be added silently."
 */
import { describe, expect, test } from 'bun:test'
import ts from 'typescript'
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
}

/**
 * Parse the shipped workflow. The file's top-level `return` is a SEMANTIC error, not a
 * syntactic one, so the parser produces a complete tree for it. Same compiler API
 * `open/__tests__/chat-command-filter-scan.ts` scans with.
 *
 * THE COMPLETENESS OF THE PARSE IS ASSERTED, NOT CLAIMED IN PROSE. This docblock used to
 * carry "checked: 214 statements", a number that was true when written and silently false
 * the moment `main` moved under it — a list claiming completeness is a claim, and it needs
 * the same scrutiny as the code it describes. A truncated parse is the one failure that
 * would make every assertion in this file vacuous while looking clean, so the test below
 * measures it instead of trusting a comment.
 */
function parse(src: string): ts.SourceFile {
  return ts.createSourceFile('inner-workflow.mjs', src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS)
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
 *  | `lookup` (scope chain)      | one scope at a time           | neither — it   |
 *  |                             |                               | reads          |
 *  |                             |                               | `.statements`  |
 *  | `bindsInPattern`            | one binding pattern           | `walkOwnScope` |
 *  | `composerReturnLiteral`     | one function body             | `walkOwnScope` |
 *
 * The first is the only one whose construct genuinely IS the whole file, which is why it
 * is the only remaining use of the unrestricted walk.
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
  const sf = parse(src)
  const sites: TerminalSite[] = []
  const lineOf = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
  walk(sf, (n) => {
    if (!ts.isCallExpression(n)) return
    if (!callsTerminalWrite(n)) return
    const arg = n.arguments[0]
    const line = lineOf(n)
    if (arg === undefined) {
      sites.push({ label: '(no argument)', line, stamped: 'unresolved', kind: null, why: 'called with no argument' })
      return
    }
    const label = ts.isIdentifier(arg) ? arg.text : ts.SyntaxKind[arg.kind]
    const resolved = resolveToObjectLiteral(arg)
    if (resolved === null) {
      sites.push({
        label,
        line,
        stamped: 'unresolved',
        kind: null,
        // The shape is NAMED, not just refused — a guard that says only "no" leaves the
        // next author guessing which of the handled forms they missed.
        why: `argument is a ${ts.SyntaxKind[arg.kind]} the scanner cannot resolve to an object literal`,
      })
      return
    }
    sites.push({ label, line, ...readCause(resolved) })
  })
  return sites
}

/**
 * IS THIS A CALL TO `writeTerminalResult`? Asked of the CALLEE and of nothing else.
 *
 * BOTH SPELLINGS, because the axis the argument fix closed has a twin. Today the function
 * is a flat top-level declaration and every call is a bare identifier, so
 * `PropertyAccessExpression` is unreachable — and that is exactly the argument the first
 * cut could have made for identifier-only arguments the day before someone wrote an
 * inline literal. A recogniser narrowed to what the file happens to contain is a
 * recogniser that stops working the moment the file changes, which is the whole defect
 * class this file is about.
 */
function callsTerminalWrite(n: ts.CallExpression): boolean {
  if (ts.isIdentifier(n.expression)) return n.expression.text === 'writeTerminalResult'
  if (ts.isPropertyAccessExpression(n.expression)) return n.expression.name.text === 'writeTerminalResult'
  return false
}

/** The object literal an argument ultimately names, or `null` when it names none. */
function resolveToObjectLiteral(arg: ts.Expression): ts.ObjectLiteralExpression | null {
  if (ts.isObjectLiteralExpression(arg)) return arg
  if (!ts.isIdentifier(arg)) return null
  const bound = lookup(arg.text, arg)
  // A FUNCTION DECLARATION IS NOT AN OBJECT, and neither is an opaque binding. Both refuse.
  if (bound === null || bound.kind !== 'value') return null
  if (ts.isObjectLiteralExpression(bound.init)) return bound.init
  // A composer call — follow it into that function's OWN `return`, resolving the composer
  // name from the CALL's position so a shadowed composer refuses like any other name.
  if (ts.isCallExpression(bound.init) && ts.isIdentifier(bound.init.expression)) {
    return composerReturnLiteral(bound.init.expression.text, bound.init.expression)
  }
  return null
}

/**
 * WHAT DOES THIS NAME MEAN, AT THIS USE SITE? — the ONE scope-chain lookup, shared by the
 * argument resolver and the composer resolver so the two cannot drift apart.
 *
 * THE DEFECT THIS REPLACED, AND IT IS THIS FILE'S OWN DEFECT MORE THAN ONCE. The first
 * resolver walked the WHOLE source for any `VariableDeclaration` whose name text matched
 * and whose position was earlier, taking the nearest. It consulted no scope — and a
 * function PARAMETER is not a `VariableDeclaration`, so it did not merely lose the
 * ranking, it was INVISIBLE:
 *
 *     const result = { terminalCauseKind: 'workflow-threw' }
 *     function newExitPath(result) {
 *       writeTerminalResult(result)          // ← an unstamped parameter
 *     }
 *
 * The callee matches, so the site is SEEN and the count grows to 13 — and then the
 * argument resolves to the OUTER literal, the site is classified as stamped, and
 * `failingSites()` comes back empty. Seen, counted, and silently passing.
 *
 * THE RULE, WHICH IS LEXICAL AND CHEAP. Walk UP from the use site through the enclosing
 * scopes. The FIRST scope that binds the name decides, whatever it turns out to be — a
 * shadowing binding STOPS the walk instead of being stepped over. `'opaque'` covers every
 * binding this scanner will not read through (a parameter, a catch variable, a
 * destructured name, a declaration with no initialiser), and the callers turn it into
 * `'unresolved'`, which already fails the guard loudly.
 *
 * IT ERRS TOWARD REFUSAL, WHICH IS THE ONLY DIRECTION THIS GUARD MAY FAIL IN. A scanner
 * that guesses is worse than one that stops, because the guess is indistinguishable from a
 * clean result. NOT A TYPE CHECKER, deliberately: it answers a lexical question from the
 * tree, which is what naming a binding is.
 */
type Binding =
  | { kind: 'value'; init: ts.Expression }
  | { kind: 'function'; decl: ts.FunctionDeclaration }
  | { kind: 'opaque' }

function lookup(name: string, use: ts.Node): Binding | null {
  for (let scope: ts.Node | undefined = use.parent; scope !== undefined; scope = scope.parent) {
    if (!introducesScope(scope)) continue
    const found = bindingIn(scope, name)
    if (found !== null) return found
  }
  return null
}

function introducesScope(n: ts.Node): boolean {
  return ts.isSourceFile(n) || ts.isBlock(n) || ts.isCatchClause(n) || ts.isFunctionLike(n)
}

/** Does this ONE scope bind `name`? `null` means keep walking outward. */
function bindingIn(scope: ts.Node, name: string): Binding | null {
  if (ts.isFunctionLike(scope)) {
    for (const param of scope.parameters) {
      if (ts.isIdentifier(param.name) ? param.name.text === name : bindsInPattern(param.name, name)) {
        return { kind: 'opaque' }
      }
    }
  }
  if (ts.isCatchClause(scope) && scope.variableDeclaration !== undefined) {
    const v = scope.variableDeclaration.name
    if (ts.isIdentifier(v) ? v.text === name : bindsInPattern(v, name)) return { kind: 'opaque' }
  }
  const statements = ts.isSourceFile(scope) || ts.isBlock(scope) ? scope.statements : undefined
  if (statements === undefined) return null
  for (const st of statements) {
    if (ts.isFunctionDeclaration(st) && st.name?.text === name) return { kind: 'function', decl: st }
    if (!ts.isVariableStatement(st)) continue
    for (const d of st.declarationList.declarations) {
      if (!ts.isIdentifier(d.name)) {
        if (bindsInPattern(d.name, name)) return { kind: 'opaque' }
        continue
      }
      if (d.name.text !== name) continue
      return d.initializer === undefined ? { kind: 'opaque' } : { kind: 'value', init: d.initializer }
    }
  }
  return null
}

/**
 * Does a destructuring pattern bind `name` anywhere inside it?
 *
 * `walkOwnScope`, because a default value may itself be a function — `({ a = ({ x }) => x })`
 * binds `a`, and the `x` inside that arrow is the ARROW's parameter, not this pattern's.
 * The unrestricted walk answered yes for `x` and refused a site over a binding that was
 * never in scope. That direction is the safe one, so it was never going to be caught by a
 * false pass — which is exactly why it needed the audit rather than a failure to find it.
 */
function bindsInPattern(pattern: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(pattern)) return pattern.text === name
  let hit = false
  walkOwnScope(pattern, (n) => {
    if (ts.isBindingElement(n) && ts.isIdentifier(n.name) && n.name.text === name) hit = true
  })
  return hit
}

/**
 * THE OBJECT LITERAL A NAMED FUNCTION RETURNS, or `null`.
 *
 * TWO BOUNDARIES, AND BOTH WERE CROSSED. The function was looked up by walking the WHOLE
 * file for a declaration with a matching name, and its `return` was found by walking its
 * ENTIRE subtree — so a literal inside a NESTED function was returned as if it were the
 * composer's own result:
 *
 *     function newExitResult() {
 *       function decoy() {
 *         return { terminalCauseKind: 'workflow-threw' }   // ← this was believed
 *       }
 *       return { ok: false, checkpoint: 'new-exit' }        // ← this is the result
 *     }
 *
 * Seen, counted, and classified as stamped while the real result carried no cause. Same
 * defect as the scope-blind resolver above, in a different traversal — which is why the
 * fix is the shared `lookup` plus `walkOwnScope`, not a patch to this one function.
 *
 * The FIRST own-scope `return` of an object literal wins; a composer whose result is
 * assembled some other way resolves to `null`, which refuses loudly.
 */
function composerReturnLiteral(name: string, use: ts.Node): ts.ObjectLiteralExpression | null {
  const bound = lookup(name, use)
  if (bound === null || bound.kind !== 'function') return null
  let out: ts.ObjectLiteralExpression | null = null
  walkOwnScope(bound.decl, (n) => {
    if (out === null && ts.isReturnStatement(n) && n.expression !== undefined && ts.isObjectLiteralExpression(n.expression)) {
      out = n.expression
    }
  })
  return out
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
function readCause(obj: ts.ObjectLiteralExpression): Pick<TerminalSite, 'stamped' | 'kind' | 'why'> {
  for (const prop of obj.properties) {
    if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === 'terminalCauseKind') {
      return { stamped: 'computed', kind: null, why: '' }
    }
    if (!ts.isPropertyAssignment(prop)) continue
    const key = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null
    if (key !== 'terminalCauseKind') continue
    return ts.isStringLiteralLike(prop.initializer)
      ? { stamped: 'literal', kind: prop.initializer.text, why: '' }
      : { stamped: 'computed', kind: null, why: '' }
  }
  return { stamped: 'absent', kind: null, why: 'the result object has no terminalCauseKind property' }
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
  test('the parse is COMPLETE — a truncated tree would make every assertion below vacuous', () => {
    // The floor under the floor. A parse that stopped early would yield few statements and
    // few calls, and every "no failing sites" assertion would pass on a tree that never
    // contained the code. Measured against the file's real size rather than a number
    // copied into a comment, so `main` moving cannot make it quietly untrue.
    const sf = parse(SRC)
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
   * `bindsInPattern` asks whether a destructuring pattern binds a name. A default value
   * may itself be a function, and the names in THAT function's parameters belong to it,
   * not to the pattern — so a traversal that walks the whole subtree answers yes for a
   * binding that was never in scope and refuses a site it should have read.
   *
   * That direction fails SAFE: it produces a false refusal, never a false pass, so it was
   * never going to be caught by the controls above. It is here because the audit found it,
   * which is the argument for auditing every traversal rather than fixing the one that was
   * reported.
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
  const load = (): Stamp => {
    const at = SRC.indexOf('function stampTerminalCause(')
    expect(at).toBeGreaterThan(-1)
    return new Function(
      [
        /const TERMINAL_CAUSE_KINDS = \[[\s\S]*?\n\]/.exec(SRC)![0],
        braceMatchFrom(SRC, at),
        'return stampTerminalCause',
      ].join('\n'),
    )() as Stamp
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
    const f = new Function(
      [
        /const TERMINAL_CAUSE_KINDS = \[[\s\S]*?\n\]/.exec(SRC)![0],
        mutated,
        'return stampTerminalCause',
      ].join('\n'),
    )() as Stamp
    const r: Record<string, unknown> = { checkpoint: 'forge-done' }
    f(r, () => {})
    expect(r.terminalCauseKind).toBeUndefined()
  })

  test('a non-object is returned untouched rather than thrown over', () => {
    expect(() => load()(null, () => {})).not.toThrow()
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
