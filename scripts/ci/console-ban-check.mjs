#!/usr/bin/env bun
// O2 bare-`console.*` gate (world-class-refactor plan §O2 part 3).
//
// The repo consolidated FOUR ad-hoc logging conventions onto ONE logger
// (`@neutronai/logger`, `createLogger(subsystem)` → `[subsystem] event=… k=v`).
// This gate BANS a bare `console.<method>` in HOST/PRODUCT server code so a new
// ad-hoc `console.log` can't creep back in and re-fork the convention — the
// keystone that makes "four conventions → one" stick.
//
// WHAT IT FLAGS — a member access `console.<m>` where `<m>` is one of the
// OUTPUT methods (`log|info|warn|error|debug|trace|dir|table|group|groupEnd|
// groupCollapsed|count|countReset`) and `console` is a BARE global identifier
// (not a locally-declared/imported/parameter binding named `console`, so a
// deliberate `const console = deps.console` shim or a `{ console }` destructure
// is left alone). This is an AST check (not a grep), so a `console.log` inside a
// string literal or a `//`-comment is never seen.
//
// WHAT IT DOES NOT FLAG (allow-list, mirroring the F3 gate's path scoping):
//   * the logger package itself (`logger/`) — its default sink IS `console.*`.
//   * genuine CLI entrypoints whose stdout/stderr IS the user-facing product
//     (the doctors + the migration runner) — see CLI_ENTRYPOINTS.
//   * browser / React-Native client code that cannot import the Node logger
//     (`app/`, `landing/chat-react/`) and every `.tsx` (only `.ts` is scanned).
//   * the contracts-band `loop/` leaf + bundled `cores/` — forbidden from
//     importing `@neutronai/logger` (dependency-cruiser `cores-use-sdk-only` +
//     the loop leaf invariant), so the host logger is unavailable there.
//   * `scripts/` + `bin/` build/CLI tooling.
//   * TEST files — a test may `spyOn(console.*)` or model prod output.
//
// BASELINE (temporary, O2) — `BASELINE_DEFERRED` lists the product files whose
// `console.*` sweep was DEFERRED past the first O2 landing (the sweep is large;
// the highest-traffic packages + all DI seams + spam-latches landed first).
// A file on this list may still contain `console.*`; EVERY OTHER in-scope file
// must be clean, so a brand-new `console.*` in swept code — or in a NEW file —
// fails the gate. The list is append-ONLY-shrinking: as a deferred package is
// swept, delete it here. Goal state: empty.
//
// EXIT: 0 = clean, 1 = at least one non-baseline bare `console.*` (printed).

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import ts from 'typescript'

const CONSOLE_METHODS = new Set([
  'log',
  'info',
  'warn',
  'error',
  'debug',
  'trace',
  'dir',
  'table',
  'group',
  'groupCollapsed',
  'groupEnd',
  'count',
  'countReset',
])

/**
 * Collect every bare `console.<method>(…)` in `sf`. `console` must be a global
 * identifier — a local binding (var/param/import/destructure) named `console`
 * SHADOWS the global and is deliberate, so it is not flagged. Shadowing is
 * detected by walking enclosing scopes for a declaration of the name; robust
 * enough without a full type-checker (matching this gate's lightweight,
 * syntactic-with-scope-awareness design).
 */
export function collectConsoleHits(sf) {
  const out = []
  const visit = (node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'console' &&
      CONSOLE_METHODS.has(node.name.text) &&
      !isShadowed(node.expression)
    ) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
      out.push({ line: line + 1, text: firstLine(node.parent?.getText(sf) ?? node.getText(sf)) })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

function firstLine(s) {
  return s.split('\n')[0].trim().slice(0, 120)
}

/** True iff an identifier named `console` has a local declaration in some
 *  enclosing scope (so it shadows the global and must not be flagged). */
function isShadowed(ident) {
  const name = ident.text
  let node = ident.parent
  while (node) {
    if (
      ts.isSourceFile(node) ||
      ts.isBlock(node) ||
      ts.isModuleBlock(node) ||
      ts.isFunctionLike(node) ||
      ts.isForStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isCatchClause(node)
    ) {
      if (scopeDeclaresName(node, name)) return true
    }
    node = node.parent
  }
  return false
}

function scopeDeclaresName(scope, name) {
  let found = false
  // Function/arrow params.
  if (ts.isFunctionLike(scope) && Array.isArray(scope.parameters)) {
    for (const p of scope.parameters) if (bindingHasName(p.name, name)) found ||= true
  }
  if (ts.isCatchClause(scope) && scope.variableDeclaration) {
    if (bindingHasName(scope.variableDeclaration.name, name)) found = true
  }
  const stmts = scope.statements ?? scope.body?.statements
  if (Array.isArray(stmts)) {
    for (const st of stmts) {
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) if (bindingHasName(d.name, name)) found = true
      } else if (ts.isImportDeclaration(st)) {
        const nb = st.importClause?.namedBindings
        if (st.importClause?.name?.text === name) found = true
        if (nb && ts.isNamespaceImport(nb) && nb.name.text === name) found = true
        if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) if (el.name.text === name) found = true
      } else if (ts.isFunctionDeclaration(st) && st.name?.text === name) {
        found = true
      }
    }
  }
  return found
}

/** Does a binding name (identifier / object / array pattern) bind `name`? */
function bindingHasName(binding, name) {
  if (!binding) return false
  if (ts.isIdentifier(binding)) return binding.text === name
  if (ts.isObjectBindingPattern(binding) || ts.isArrayBindingPattern(binding)) {
    return binding.elements.some((el) => ts.isBindingElement(el) && bindingHasName(el.name, name))
  }
  return false
}

/** Detector entry point for unit tests. */
export function findBareConsoleCalls(source, fileName = 'fixture.ts') {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  return collectConsoleHits(sf)
}

// ── Scope / allow-list ─────────────────────────────────────────────────
const ROOT = join(import.meta.dir, '..', '..')
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', '.expo', '.claude', 'coverage'])

// Browser / RN client, contracts-band leaf, bundled Cores, build/CLI tooling —
// cannot or must not import the host logger.
const EXCLUDE_PREFIXES = ['app/', 'landing/chat-react/', 'loop/', 'cores/', 'scripts/', 'bin/', 'logger/']

// Genuine CLI entrypoints whose console output IS the user-facing product.
const CLI_ENTRYPOINTS = new Set([
  'gbrain-memory/gbrain-doctor.ts',
  'open/diagnostics-cli.ts',
  'open/diagnostics-cli-impl.ts',
  'open/server.ts', // `import.meta.main` boot shell — the console.info block IS a user-facing boot banner.
  'migrations/runner.ts',
  'migrations/regen-snapshot.ts',
])

// TEMPORARY O2 baseline — product files whose console.* sweep was deferred past
// the first O2 landing. SHRINK to empty. See header.
const BASELINE_DEFERRED = new Set([
  // __O2_BASELINE__ (generated list is inserted here)
])

function isTestPath(rel) {
  return (
    rel.includes('/__tests__/') ||
    rel.startsWith('__tests__/') ||
    rel.includes('.test.') ||
    rel.startsWith('tests/') ||
    rel.includes('/tests/') ||
    rel.includes('__fixtures__/') ||
    rel.includes('/fixtures/')
  )
}

function inScope(rel) {
  if (!rel.endsWith('.ts') || rel.endsWith('.d.ts')) return false
  if (isTestPath(rel)) return false
  if (CLI_ENTRYPOINTS.has(rel)) return false
  if (BASELINE_DEFERRED.has(rel)) return false
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

if (import.meta.main) {
  const files = []
  walk(ROOT, files)
  const offenders = []
  for (const abs of files) {
    const rel = abs.slice(ROOT.length + 1).split(sep).join('/')
    if (!inScope(rel)) continue
    const src = readFileSync(abs, 'utf8')
    if (!/console\s*\./.test(src)) continue // cheap prefilter
    const sf = ts.createSourceFile(abs, src, ts.ScriptTarget.Latest, true)
    for (const hit of collectConsoleHits(sf)) offenders.push(`${rel}:${hit.line}  ${hit.text}`)
  }
  if (offenders.length > 0) {
    console.error(
      'Bare `console.*` found in host/product code — use `createLogger(<subsystem>)` from @neutronai/logger:',
    )
    for (const o of offenders) console.error('  ' + o)
    console.error(`\nCONSOLE GATE: FAILED — ${offenders.length} found`)
    process.exit(1)
  }
  console.log('CONSOLE GATE (bare console.* outside the logger + CLI entrypoints): 0 found ✅')
}
