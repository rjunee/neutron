#!/usr/bin/env bun
// F3 fire-and-forget gate (world-class-refactor plan §F3).
//
// The repo had ~30 bare `void somePromise(…)` fire-and-forget sites — a voided
// promise whose rejection is SILENTLY swallowed. F3 introduced
// `fireAndForget(name, p)` (@neutronai/logger) which logs + counts a rejection
// instead of dropping it. This gate BANS the bare form so new swallowed
// failures can't creep back in: every such site must go through the wrapper.
//
// WHAT IT FLAGS — a `void <expr>` whose operand is a Promise/thenable, decided
// by the TYPE CHECKER (not the AST shape), in STATEMENT **or** EXPRESSION
// position (a callback body, ternary arm, etc.). This closes two Codex-flagged
// bypasses — a promise VARIABLE and a nested/expression-position void:
//   `const p: Promise<void> = …; void p`     ← flagged (operand is a Promise)
//   `void emitSystemEvent({…})`               ← flagged (call returns a Promise)
//   `void handle.stop().catch(…)`             ← flagged (chain is still a Promise)
//   `setTimeout(() => void p, 0)`             ← flagged (expression-position void)
//
// WHAT IT DOES NOT FLAG — a `void <expr>` whose operand is NOT promise-typed:
//   * `void 0` / `void <literal>` — the classic no-op.
//   * `void _exhaustive` / `void driver` / `void this._deps` — the "silence an
//     unused binding/import" idiom. These are non-promise values; the checker
//     confirms it, so they are left alone WITHOUT a hand-maintained allowlist.
//   * `void someSyncFn()` — a call returning a non-promise.
//
// INHERENT LIMIT (by design, NOT a hole) — `void p` where `p: any` is NOT
// flagged: `any` erases the type, so the checker cannot prove `p` is a promise,
// and flagging every `void <any>` would false-positive on legitimate
// `void someAny` no-ops. `any`/`unknown`-erased operands are therefore OUT OF
// SCOPE — the gate catches STATICALLY-promise-typed voids (`Promise<T>`,
// `PromiseLike<T>`, promise-returning calls/chains). This boundary is
// intentional and locked by tests (`void <any>` → not flagged; `void <Promise>`
// / `void <PromiseLike>` → flagged). A rare `void <unknown>` could in principle
// be flagged without false positives, but is left in scope with `any` for a
// single, simple rule.
//
// SCOPE — server-side Node `.ts` only. Excludes browser/React-Native client
// code (it cannot import the Node console/env logger, and `void handler()` in a
// React effect is idiomatic there): `app/`, `landing/chat-react/`, `chat-core/`
// (the browser web-session lib), `landing/connect-accept.ts` (browser accept
// client), and all `.tsx`. The wrapper's own definition file
// (`logger/fire-and-forget.ts`) owns the only sanctioned `void <promise>`
// (inside `fireAndForget` / `neutralizeAbandonedSettle`).
//
// TESTS ARE EXCLUDED — BY DECISION (P2). The F3 invariant is a PRODUCTION
// reliability rule (make prod fire-and-forget failures visible). Test code may
// intentionally bare-`void` a promise to MODEL production behavior without
// asserting on the wrapper: e.g. `persistence/system-events.test.ts` fires
// `void emitSystemEventSafe(...)` (the SAFE variant, which swallows its own
// errors and never rejects) to reproduce the degrade-site "fire without
// awaiting" path and then exercise `drain()` durability. Wrapping those in
// `fireAndForget` would be a no-op (nothing rejects) and would couple the test
// to the wrapper it isn't testing, so tests stay excluded from BOTH the
// void-promise gate and the pre-swallow gate.
//
// Comments/strings can't false-positive: this parses the real TS AST + resolves
// types (not a grep), so a `void foo()` quoted in a doc-comment is never seen.
//
// EXIT: 0 = no bare void-promise statements, 1 = at least one (printed).

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import ts from 'typescript'

// ── Promise classification (type-driven) ──────────────────────────────
// True iff `type` (or any member of a union/intersection) is a Promise or a
// thenable — i.e. carries a callable `then`. Robust across TS builds: tries the
// dedicated `getPromisedTypeOfPromise` API, a `Promise`-named symbol, and a
// structural callable-`then` probe, each guarded so a checker quirk can never
// throw the gate.
function isPromiseLikeType(checker, type) {
  const seen = new Set()
  const probe = (t) => {
    if (t == null || seen.has(t)) return false
    seen.add(t)
    // eslint-disable-next-line no-bitwise
    if ((t.flags & ts.TypeFlags.UnionOrIntersection) !== 0 && Array.isArray(t.types)) {
      return t.types.some(probe)
    }
    try {
      if (typeof checker.getPromisedTypeOfPromise === 'function') {
        if (checker.getPromisedTypeOfPromise(t) !== undefined) return true
      }
    } catch {
      /* fall through to the structural probes */
    }
    const sym = (typeof t.getSymbol === 'function' ? t.getSymbol() : undefined) ?? t.symbol
    if (sym && typeof sym.getName === 'function' && sym.getName() === 'Promise') return true
    try {
      const apparent = checker.getApparentType ? checker.getApparentType(t) : t
      const then =
        (typeof apparent.getProperty === 'function' && apparent.getProperty('then')) ||
        checker.getPropertyOfType?.(apparent, 'then')
      if (then) {
        const decl = then.valueDeclaration ?? then.declarations?.[0]
        if (decl) {
          const tt = checker.getTypeOfSymbolAtLocation(then, decl)
          if (tt && typeof tt.getCallSignatures === 'function' && tt.getCallSignatures().length > 0) {
            return true
          }
        }
      }
    } catch {
      /* not classifiable structurally — treat as non-promise */
    }
    return false
  }
  return probe(type)
}

/** Walk a bound source file, collecting every `void <promise>` — in STATEMENT
 *  OR EXPRESSION position (`() => void p`, `setTimeout(() => void p)`, a ternary
 *  arm, etc.), so a promise-void can't hide inside a callback body. */
function collectVoidPromiseHits(sf, checker) {
  const out = []
  const visit = (node) => {
    if (ts.isVoidExpression(node)) {
      const operand = node.expression
      // Fast skip for `void <literal>` (never a promise) before touching types.
      const isLiteral =
        ts.isNumericLiteral(operand) ||
        ts.isStringLiteralLike(operand) ||
        operand.kind === ts.SyntaxKind.TrueKeyword ||
        operand.kind === ts.SyntaxKind.FalseKeyword ||
        operand.kind === ts.SyntaxKind.NullKeyword
      if (!isLiteral) {
        const type = checker.getTypeAtLocation(operand)
        if (isPromiseLikeType(checker, type)) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
          out.push({ line: line + 1, text: node.getText(sf).split('\n')[0].trim() })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

// In-memory compiler options for the exported (unit-test) entry point. Fixtures
// are self-contained (they `declare` their own types), so a default-lib program
// with no project resolution is enough to type `void p`.
const IN_MEMORY_OPTIONS = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: false,
  noEmit: true,
  skipLibCheck: true,
}

/**
 * Detector entry point for unit tests: type-check `source` in isolation and
 * return every `void <promise>` statement. Fixtures must `declare` any symbol
 * whose promise-ness matters (cross-file imports don't resolve in isolation).
 * @param {string} source     TS source text.
 * @param {string} [fileName] virtual file name for the parse.
 * @returns {{line:number, text:string}[]} 1-based line + first line of text.
 */
export function findBareVoidPromiseCalls(source, fileName = 'fixture.ts') {
  const host = ts.createCompilerHost(IN_MEMORY_OPTIONS, true)
  const virtual = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true)
  const origGetSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (name, langVersion, onError, shouldCreate) =>
    name === fileName ? virtual : origGetSourceFile(name, langVersion, onError, shouldCreate)
  const origFileExists = host.fileExists.bind(host)
  host.fileExists = (name) => name === fileName || origFileExists(name)
  const origReadFile = host.readFile.bind(host)
  host.readFile = (name) => (name === fileName ? source : origReadFile(name))

  const program = ts.createProgram([fileName], IN_MEMORY_OPTIONS, host)
  const checker = program.getTypeChecker()
  const sf = program.getSourceFile(fileName)
  return sf ? collectVoidPromiseHits(sf, checker) : []
}

// ── Pre-swallow gate (SYNTACTIC — no type inference) ──────────────────
// A `fireAndForget(name, p, onError?)` / `neutralizeAbandonedSettle(p)` call
// must receive a promise whose rejection can REACH the wrapper. A `.catch(...)`
// anywhere in the argument's chain, a two-argument `.then(onF, onRej)`, or an
// immediately-invoked async function whose body catches WITHOUT rethrowing all
// swallow the rejection BEFORE the wrapper — so its count/log never fires (the
// recurring F3 "pre-swallow" bug). Now that `fireAndForget` takes an `onError`
// callback, a pre-wrapper `.catch` is ALWAYS the wrong shape. This is a pure
// AST-shape check (robust + complete; no types needed) that bans it forever.

/** A catch clause counts as a SAFE rethrow ONLY if it rethrows
 *  UNCONDITIONALLY — a `throw` at the TOP LEVEL of the catch block's statement
 *  list. A throw nested inside an `if`/`for`/`while`/`switch`/`try`/`&&`/`?:`
 *  can be skipped, so on the other branch the catch SWALLOWS — that is NOT a
 *  safe rethrow. Conservative by design: err toward treating a
 *  conditional/nested throw as a swallow. */
function catchRethrowsUnconditionally(catchClause) {
  if (!catchClause.block) return false
  return catchClause.block.statements.some((s) => ts.isThrowStatement(s))
}

/** True iff `fn` (arrow/function) body has a `catch` clause that does NOT
 *  unconditionally rethrow (walking only its own body, not nested functions). */
function iifeHasNonRethrowingCatch(fn) {
  let swallows = false
  const visit = (n) => {
    if (swallows) return
    if (ts.isCatchClause(n)) {
      if (!catchRethrowsUnconditionally(n)) {
        swallows = true
        return
      }
    }
    if (ts.isFunctionLike(n) && n !== fn) return // don't descend nested fns
    ts.forEachChild(n, visit)
  }
  if (fn.body) visit(fn.body)
  return swallows
}

/** Classify a wrapper's promise argument: returns a reason string if it
 *  pre-swallows a rejection, else null. */
function classifyWrapperArg(arg) {
  let a = arg
  while (a) {
    while (ts.isParenthesizedExpression(a)) a = a.expression
    if (!ts.isCallExpression(a)) return null // identifier / plain expr → OK
    let callee = a.expression
    while (ts.isParenthesizedExpression(callee)) callee = callee.expression
    // IIFE: (async () => {...})() / (function(){...})()
    if (ts.isArrowFunction(callee) || ts.isFunctionExpression(callee)) {
      return iifeHasNonRethrowingCatch(callee) ? 'IIFE body catches without rethrowing' : null
    }
    // chained `.method(...)` — inspect + descend the receiver
    if (ts.isPropertyAccessExpression(callee)) {
      const m = callee.name.text
      if (m === 'catch') return 'a `.catch(...)` swallows before the wrapper (use the onError arg)'
      if (m === 'then' && a.arguments.length >= 2) {
        return 'a two-arg `.then(onF, onRej)` swallows before the wrapper (use the onError arg)'
      }
      a = callee.expression // descend past `.then(1)` / `.finally(...)` (rejection passes through)
      continue
    }
    return null // base call like foo(...) → OK
  }
  return null
}

// ── One-hop local-variable resolution (LIMITED, best-effort) ──────────
// A pre-swallow can be laundered through a local binding:
//   const s = p.catch(() => {}); fireAndForget('n', s)
// When a wrapper's promise arg is a plain IDENTIFIER, resolve it ONE HOP to a
// local `const`/`let` initializer in the SAME scope (a simple, non-reassigned
// binding) and re-run the shape checks on that initializer.
//
// INHERENT BOUNDARY (documented + locked by tests) — a SYNTACTIC lint gate
// cannot catch every dataflow-laundered pre-swallow. Multi-hop chains
// (`const a = p.catch(); const b = a; fireAndForget(n, b)`), a REASSIGNED
// binding, a promise returned from another function, stored in an object/array
// then passed, or a `.catch` applied conditionally elsewhere are general
// dataflow (undecidable) and OUT OF SCOPE — the gate does NOT flag them, by
// design. This gate is a best-effort REGRESSION PREVENTER for the DIRECT +
// LOCAL-ONE-HOP shapes, NOT a proof of no-pre-swallow. The ACTUAL guarantee is
// the RUNTIME wrapper (`fireAndForget` always logs+counts a rejection it
// RECEIVES) + the process safety net; a promise that never reaches the wrapper
// is a code-review concern the gate best-effort-flags, not a soundness hole in
// the reliability mechanism.
//
// The one-hop LOCAL check is swallow-aware (flags a `.catch` that does NOT
// unconditionally rethrow, or a two-arg `.then`); a laundered rethrow
// (`const s = p.catch(e => { throw e })`) passes because its rejection still
// reaches the wrapper. A laundered IIFE is NOT descended into (see
// classifyResolvedInitializer) — the direct IIFE check still covers a
// directly-passed swallowing IIFE.

/** True iff a rejection handler UNCONDITIONALLY rethrows (a `throw` at the top
 *  level of its block body). A concise-body arrow returns a value → swallows. */
function rejectionHandlerRethrows(handler) {
  if (!handler || !ts.isFunctionLike(handler)) return false
  return handler.body && ts.isBlock(handler.body)
    ? handler.body.statements.some((s) => ts.isThrowStatement(s))
    : false
}

/** Swallow-aware classify for a ONE-HOP-resolved local initializer.
 *
 *  Scoped to the `.catch` / two-arg `.then` laundered-swallow shapes (the common
 *  aliasing bug). It deliberately does NOT descend into a laundered IIFE body:
 *  the "any non-rethrowing catch = swallow" heuristic OVER-approximates through
 *  a local binding — a self-handling async IIFE assigned to a `const` (the
 *  turn-driver pattern in pool.ts: comprehensive internal try/catch that
 *  CLASSIFIES + surfaces failures to the channel, and can still reject on an
 *  uncaught path) is a legitimate backstop, not a silent swallow. A DIRECTLY
 *  passed swallowing IIFE is still flagged by `classifyWrapperArg`; a laundered
 *  one is part of the documented dataflow boundary (code review, not the gate). */
function classifyResolvedInitializer(init) {
  let a = init
  while (a) {
    while (ts.isParenthesizedExpression(a)) a = a.expression
    if (!ts.isCallExpression(a)) return null
    let callee = a.expression
    while (ts.isParenthesizedExpression(callee)) callee = callee.expression
    if (ts.isArrowFunction(callee) || ts.isFunctionExpression(callee)) {
      return null // laundered IIFE — out of scope (see doc above)
    }
    if (ts.isPropertyAccessExpression(callee)) {
      const m = callee.name.text
      if (m === 'catch') {
        if (rejectionHandlerRethrows(a.arguments[0])) {
          a = callee.expression // rethrows → rejection reaches the wrapper; keep checking the receiver
          continue
        }
        return 'a `.catch(...)` swallows before the wrapper via a local alias (use the onError arg)'
      }
      if (m === 'then' && a.arguments.length >= 2) {
        return 'a two-arg `.then(onF, onRej)` swallows before the wrapper via a local alias'
      }
      a = callee.expression
      continue
    }
    return null
  }
  return null
}

/** Is `name` REASSIGNED (`=`/compound/`++`/`--`) anywhere within `scope`? */
function isReassignedInScope(name, scope) {
  let found = false
  const w = (n) => {
    if (found) return
    if (
      ts.isBinaryExpression(n) &&
      ts.isIdentifier(n.left) &&
      n.left.text === name &&
      n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      n.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      found = true
      return
    }
    if (
      (ts.isPostfixUnaryExpression(n) || ts.isPrefixUnaryExpression(n)) &&
      ts.isIdentifier(n.operand) &&
      n.operand.text === name
    ) {
      found = true
      return
    }
    ts.forEachChild(n, w)
  }
  w(scope)
  return found
}

/** Resolve a plain identifier ONE HOP to its nearest-enclosing-scope `const`/
 *  `let` initializer (non-reassigned for `let`), or null. Requires parent links. */
function resolveOneHopInitializer(identNode) {
  const name = identNode.text
  let scope = identNode.parent
  while (scope) {
    const statements =
      ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope) ? scope.statements : undefined
    if (statements) {
      for (const st of statements) {
        if (!ts.isVariableStatement(st)) continue
        const flags = st.declarationList.flags
        const isConst = (flags & ts.NodeFlags.Const) !== 0
        const isLet = (flags & ts.NodeFlags.Let) !== 0
        if (!isConst && !isLet) continue
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) {
            if (isLet && isReassignedInScope(name, scope)) return null // reassigned → undecidable
            return d.initializer
          }
        }
      }
    }
    scope = scope.parent
  }
  return null
}

const WRAPPER_FNS = new Set(['fireAndForget', 'neutralizeAbandonedSettle'])

/** A module specifier that refers to the fire-and-forget wrapper module
 *  (`@neutronai/logger/fire-and-forget.ts`, or a relative `.../fire-and-forget`). */
function isFafModuleSpecifier(spec) {
  return /(^|\/)fire-and-forget(\.ts)?$/.test(spec)
}

/**
 * Resolve which LOCAL names / namespaces are bound to the wrapper functions in
 * `sf`, so an ALIASED import (`import { fireAndForget as faf }`) or a NAMESPACE
 * import (`import * as ff` → `ff.fireAndForget(...)`) is recognized — not just a
 * literal `fireAndForget` identifier.
 */
function resolveWrapperBindings(sf) {
  const localFns = new Map() // localName → 'fireAndForget' | 'neutralizeAbandonedSettle'
  const namespaces = new Set() // local name of a `import * as ns` from the module
  const walk = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && isFafModuleSpecifier(node.moduleSpecifier.text)) {
      const nb = node.importClause?.namedBindings
      if (nb && ts.isNamespaceImport(nb)) namespaces.add(nb.name.text)
      else if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) {
          const imported = (el.propertyName ?? el.name).text // original export name
          if (WRAPPER_FNS.has(imported)) localFns.set(el.name.text, imported)
        }
      }
    }
    ts.forEachChild(node, walk)
  }
  walk(sf)
  return { localFns, namespaces }
}

/** The wrapper kind a call targets (resolving aliases + namespace access), or
 *  null. Bare `fireAndForget(...)` still matches (canonical import / test
 *  fixtures without imports). */
function wrapperKindOfCall(callee, localFns, namespaces) {
  if (ts.isIdentifier(callee)) {
    return localFns.get(callee.text) ?? (WRAPPER_FNS.has(callee.text) ? callee.text : null)
  }
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    namespaces.has(callee.expression.text) &&
    WRAPPER_FNS.has(callee.name.text)
  ) {
    return callee.name.text
  }
  return null
}

/** Detector (exported for tests): every wrapper call whose promise arg
 *  pre-swallows. `fireAndForget` promise = arg[1]; `neutralizeAbandonedSettle`
 *  = arg[0]. Recognizes aliased + namespace-imported wrapper calls. */
export function findPreSwallowedWraps(source, fileName = 'fixture.ts') {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const { localFns, namespaces } = resolveWrapperBindings(sf)
  const out = []
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const fn = wrapperKindOfCall(node.expression, localFns, namespaces)
      if (fn) {
        const arg = fn === 'fireAndForget' ? node.arguments[1] : node.arguments[0]
        if (arg) {
          let reason = classifyWrapperArg(arg)
          // One-hop: a pre-swallow laundered through a local `const`/`let`.
          if (!reason && ts.isIdentifier(arg)) {
            const init = resolveOneHopInitializer(arg)
            if (init) reason = classifyResolvedInitializer(init)
          }
          if (reason) {
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
            out.push({ line: line + 1, fn, reason })
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

const ROOT = join(import.meta.dir, '..', '..')

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', '.expo', '.claude', 'coverage'])

// Repo-relative POSIX path prefixes / files that are OUT of scope. The mandate
// ("every fire-and-forget uses `fireAndForget`") applies to HOST SERVER code
// that CAN import `@neutronai/logger`. Excluded:
//   - browser / React-Native client code that can't load the Node console/env
//     logger: `app/`, `landing/chat-react/`, `chat-core/`, `connect-accept`.
//   - `loop/` — a contracts-band LEAF whose invariant (loop/AGENTS.md) forbids
//     ANY `@neutronai/*` dep; its `void this.runOnce()` goes through
//     `guardedFire` (never rejects), so it governs its own (non-)error path.
//   - `cores/` — bundled Cores + the Core SDK/runtime are ISOLATED modules that
//     must NOT import the host logger (enforced by the `cores-use-sdk-only`
//     dependency-cruiser rule); they own their error-handling (event emission
//     via cores/sdk), the Core contract's job, not F3's.
// The wrapper's own file owns the sanctioned `void <promise>`.
const EXCLUDE_PREFIXES = ['app/', 'landing/chat-react/', 'chat-core/', 'loop/', 'cores/']
const EXCLUDE_FILES = new Set(['landing/connect-accept.ts', 'logger/fire-and-forget.ts'])

function isTestPath(rel) {
  return (
    rel.includes('/__tests__/') ||
    rel.startsWith('__tests__/') ||
    rel.includes('.test.') ||
    rel.startsWith('tests/') ||
    rel.includes('/tests/')
  )
}

function inScope(rel) {
  if (!rel.endsWith('.ts') || rel.endsWith('.d.ts')) return false
  if (isTestPath(rel)) return false
  if (EXCLUDE_FILES.has(rel)) return false
  for (const p of EXCLUDE_PREFIXES) if (rel.startsWith(p)) return false
  return true
}

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (IGNORE_DIRS.has(name)) continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (name.endsWith('.ts')) out.push(full)
  }
}

/** Does this in-scope file contain ANY `void <expr>` (statement OR expression
 *  position)? Cheap AST parse, no types. The fast-reject matches the `void`
 *  KEYWORD as a word (`\bvoid\b`) — NOT the literal `"void "` — so a `void`
 *  separated from its operand by a newline (`void\np`) or an inline block
 *  comment still forwards the file to the type-aware AST pass, which handles
 *  whitespace/comments correctly. (A conservative over-forward is fine; the
 *  AST pass decides.) */
export function hasVoidExpression(abs, src) {
  if (!/\bvoid\b/.test(src)) return false
  const sf = ts.createSourceFile(abs, src, ts.ScriptTarget.ES2022, true)
  let found = false
  const visit = (node) => {
    if (found) return
    if (ts.isVoidExpression(node)) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

/** Compiler options from tsconfig.base.json (so `@neutronai/*` + `.ts` resolve). */
function loadProjectOptions() {
  const configPath = join(ROOT, 'tsconfig.base.json')
  const read = ts.readConfigFile(configPath, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, ROOT)
  return { ...parsed.options, noEmit: true, skipLibCheck: true }
}

// CLI: scan the repo. Guarded so the test can `import` the detector without
// running (or exiting) the whole gate.
if (import.meta.main) {
  const files = []
  walk(ROOT, files)

  // Two-phase for speed: (1) a cheap AST parse finds the handful of files that
  // still carry a `void <expr>` statement; (2) only those become a typed
  // program's roots (TS pulls in their imports for type resolution), so we pay
  // the type-checker cost on ~a dozen files, not the whole repo.
  const candidates = []
  for (const abs of files) {
    const rel = abs.slice(ROOT.length + 1).split(sep).join('/')
    if (!inScope(rel)) continue
    const src = readFileSync(abs, 'utf8')
    if (hasVoidExpression(abs, src)) candidates.push(abs)
  }

  const offenders = []
  if (candidates.length > 0) {
    const program = ts.createProgram(candidates, loadProjectOptions())
    const checker = program.getTypeChecker()
    for (const abs of candidates) {
      const sf = program.getSourceFile(abs)
      if (!sf) continue
      const rel = abs.slice(ROOT.length + 1).split(sep).join('/')
      for (const hit of collectVoidPromiseHits(sf, checker)) {
        offenders.push(`${rel}:${hit.line}  ${hit.text}`)
      }
    }
  }

  if (offenders.length > 0) {
    console.error(
      "Bare `void <promise>` fire-and-forget found — wrap with fireAndForget('<name>', <promise>) from @neutronai/logger/fire-and-forget.ts:",
    )
    for (const o of offenders) console.error('  ' + o)
    console.error(`\nVOID-PROMISE GATE: FAILED — ${offenders.length} found`)
    process.exit(1)
  }
  console.log('VOID-PROMISE GATE (bare void <promise> outside fireAndForget): 0 found ✅')

  // ── Pre-swallow scan (syntactic; no types) over every in-scope file that
  // mentions a wrapper. Bans a `.catch`/two-arg-`.then`/internally-catching-IIFE
  // BEFORE the wrapper, so a rejection can never be swallowed before it counts.
  const preSwallows = []
  for (const abs of files) {
    const rel = abs.slice(ROOT.length + 1).split(sep).join('/')
    if (!inScope(rel)) continue
    const src = readFileSync(abs, 'utf8')
    if (!src.includes('fireAndForget') && !src.includes('neutralizeAbandonedSettle')) continue
    for (const hit of findPreSwallowedWraps(src, abs)) {
      preSwallows.push(`${rel}:${hit.line}  ${hit.fn}(...) — ${hit.reason}`)
    }
  }
  if (preSwallows.length > 0) {
    console.error(
      '\nPre-swallowed promise handed to a fire-and-forget wrapper — pass the RAW promise' +
        ' + an onError callback so the rejection is counted/logged:',
    )
    for (const p of preSwallows) console.error('  ' + p)
    console.error(`\nPRE-SWALLOW GATE: FAILED — ${preSwallows.length} found`)
    process.exit(1)
  }
  console.log('PRE-SWALLOW GATE (no .catch/internal-catch before a fireAndForget wrapper): 0 found ✅')
}
