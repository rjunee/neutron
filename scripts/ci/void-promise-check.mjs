#!/usr/bin/env bun
// F3 fire-and-forget gate (world-class-refactor plan §F3).
//
// The repo had ~30 bare `void somePromise(…)` fire-and-forget sites — a voided
// promise whose rejection is SILENTLY swallowed. F3 introduced
// `fireAndForget(name, p)` (@neutronai/logger) which logs + counts a rejection
// instead of dropping it. This gate BANS the bare form so new swallowed
// failures can't creep back in: every such site must go through the wrapper.
//
// WHAT IT FLAGS — an expression-statement `void <CallExpression>`, e.g.
//   `void emitSystemEvent({…})`, `void handle.stop().catch(…)`,
//   `void p.then(…)`. The `void` applied to a CALL is the fire-and-forget
//   promise idiom in this codebase.
//
// WHAT IT DOES NOT FLAG (deliberately, to avoid a mountain of false positives):
//   * `void 0` / `void <literal>` — the classic no-op.
//   * `void <identifier>` / `void this.x` — the "silence an unused
//     binding/import" idiom (`void _exhaustive`, `void driver`, `void input`).
//     These are never promises. A fully-general "is it a promise" check needs
//     type info; per the plan we ban the CALL form + allowlist the wrapper,
//     which catches every real site (a fire-and-forget promise is always the
//     result of a call) without touching the unused-binding voids.
//
// SCOPE — server-side Node `.ts` only. Excludes browser/React-Native client
// code (it cannot import the Node console/env logger, and `void handler()` in a
// React effect is idiomatic there): `app/`, `landing/chat-react/`, `chat-core/`
// (the browser web-session lib), `landing/connect-accept.ts` (browser accept
// client), and all `.tsx`. Tests are excluded too. The wrapper's own
// definition file is the single allowlisted `void <promise>`.
//
// Comments/strings can't false-positive: this parses the real TS AST (not a
// grep), so a `void foo()` quoted in a doc-comment is never seen.
//
// EXIT: 0 = no bare void-promise statements, 1 = at least one (printed).

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import ts from 'typescript'

/**
 * Core detector (exported for unit tests). Returns one entry per bare
 * `void <CallExpression>` expression-statement in `source`.
 * @param {string} source     TS source text.
 * @param {string} [fileName] used only for the parse (diagnostics).
 * @returns {{line:number, text:string}[]} 1-based line + first line of text.
 */
export function findBareVoidPromiseCalls(source, fileName = 'anonymous.ts') {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const out = []
  const visit = (node) => {
    if (
      ts.isExpressionStatement(node) &&
      ts.isVoidExpression(node.expression) &&
      ts.isCallExpression(node.expression.expression)
    ) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
      out.push({ line: line + 1, text: node.getText(sf).split('\n')[0].trim() })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

const ROOT = join(import.meta.dir, '..', '..')

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', '.expo', '.claude', 'coverage'])

// Repo-relative POSIX path prefixes / files that are OUT of scope (client code
// + the wrapper's own definition, which owns the one sanctioned void-promise).
const EXCLUDE_PREFIXES = ['app/', 'landing/chat-react/', 'chat-core/']
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

// CLI: scan the repo. Guarded so the test can `import` the detector without
// running (or exiting) the whole gate.
if (import.meta.main) {
  const files = []
  walk(ROOT, files)

  const offenders = []
  for (const abs of files) {
    const rel = abs.slice(ROOT.length + 1).split(sep).join('/')
    if (!inScope(rel)) continue
    const src = readFileSync(abs, 'utf8')
    for (const hit of findBareVoidPromiseCalls(src, abs)) {
      offenders.push(`${rel}:${hit.line}  ${hit.text}`)
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
