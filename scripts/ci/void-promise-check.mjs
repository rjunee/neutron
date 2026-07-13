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
// SCOPE — server-side Node `.ts` only. Excludes browser/React-Native client
// code (it cannot import the Node console/env logger, and `void handler()` in a
// React effect is idiomatic there): `app/`, `landing/chat-react/`, `chat-core/`
// (the browser web-session lib), `landing/connect-accept.ts` (browser accept
// client), and all `.tsx`. Tests are excluded too. The wrapper's own
// definition file (`logger/fire-and-forget.ts`) owns the only sanctioned
// `void <promise>` (inside `fireAndForget` / `neutralizeAbandonedSettle`).
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
}
