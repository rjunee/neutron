#!/usr/bin/env bun
// L5 type-query gate (companion to eslint.config.mjs's no-relative-packages).
//
// ESLint's `import/no-relative-packages` visits import/export DECLARATIONS,
// `require()`, and value-position dynamic `import()` — but NOT TypeScript
// TYPE-POSITION `import('...').Foo` queries (a `TSImportType` AST node the
// rule's moduleVisitor never sees). Those can still reach across a workspace
// package root with a relative path (`import('../../runtime/substrate.ts').X`)
// and silently couple packages exactly like a relative static import.
//
// This check closes that hole: it scans every `.ts`/`.tsx` file, finds every
// `import('<relative>')` occurrence, resolves the target against the importing
// file's directory, and FAILS if the target lands in a DIFFERENT workspace
// package than the importer. The fix is always the same mechanical rename to
// `import('@neutronai/<pkg>/...')`.
//
// It is intentionally resolution-based (not a bare grep on `../<pkg>/`): a
// grep would false-positive on an intra-package `import('../sibling.ts')`
// whose first segment happens to match a workspace name, and false-negative
// on deeper escapes. Resolving the path is exact.
//
// Whole-line `//` and block-comment (`*`-prefixed) lines are stripped before
// scanning so a doc-comment that quotes an old relative path as prose doesn't
// trip the gate — real code never carries a comment marker on the import line.
//
// EXIT: 0 = no cross-package relative type-queries, 1 = at least one (printed).

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, normalize, sep } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')

const WORKSPACES = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).workspaces

/** Longest-prefix workspace dir owning a repo-relative POSIX path, or null. */
function workspaceFor(relPath) {
  let best = null
  for (const w of WORKSPACES) {
    if (relPath === w || relPath.startsWith(w + '/')) {
      if (best === null || w.length > best.length) best = w
    }
  }
  return best
}

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', '.expo', '.claude', 'coverage'])

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (IGNORE_DIRS.has(name)) continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (name.endsWith('.ts') || name.endsWith('.tsx')) out.push(full)
  }
}

// Blank out `//` line comments and `/* */` block comments while PRESERVING
// string/template literals (the specifier we hunt lives inside one) and every
// newline (so byte offsets → line numbers stay exact). A tiny char state
// machine — NOT a per-line heuristic — because an `import(...)` type query can
// span multiple lines (`import(\n  '../pkg/x.ts'\n)`), which a line-scanner
// misses, and because a commented-out or in-prose `import('../x')` must NOT
// trip the gate. Comment chars become spaces; string bodies are copied verbatim.
function blankComments(src) {
  let out = ''
  let state = 'code' // code | line | block | sq | dq | tpl
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i]
    const c2 = src[i + 1]
    if (state === 'code') {
      if (c === '/' && c2 === '/') { state = 'line'; out += '  '; i += 1; continue }
      if (c === '/' && c2 === '*') { state = 'block'; out += '  '; i += 1; continue }
      if (c === "'") { state = 'sq'; out += c; continue }
      if (c === '"') { state = 'dq'; out += c; continue }
      if (c === '`') { state = 'tpl'; out += c; continue }
      out += c; continue
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += '\n' } else { out += ' ' }
      continue
    }
    if (state === 'block') {
      if (c === '*' && c2 === '/') { state = 'code'; out += '  '; i += 1 }
      else { out += c === '\n' ? '\n' : ' ' }
      continue
    }
    // string states (sq/dq/tpl): copy verbatim, honour escapes + terminator.
    out += c
    if (c === '\\') { out += src[i + 1] ?? ''; i += 1; continue }
    if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tpl' && c === '`')) {
      state = 'code'
    }
  }
  return out
}

// `import( '<relative>' )` — captures a relative specifier ( ./ or ../ ). The
// `\s*` around the quote spans newlines, so a multiline type query is caught.
const TYPE_QUERY = /import\(\s*(['"])(\.\.?\/[^'"]+)\1\s*\)/g

const files = []
walk(ROOT, files)

const offenders = []
for (const abs of files) {
  const rel = abs.slice(ROOT.length + 1).split(sep).join('/')
  const srcWs = workspaceFor(rel)
  const importerDir = dirname(rel)
  const body = blankComments(readFileSync(abs, 'utf8'))
  for (const m of body.matchAll(TYPE_QUERY)) {
    const spec = m[2]
    const target = normalize(join(importerDir, spec)).split(sep).join('/')
    const tgtWs = workspaceFor(target)
    if (tgtWs !== null && tgtWs !== srcWs) {
      // Line number = newlines before the match (offsets preserved by blanking).
      const lineNo = body.slice(0, m.index).split('\n').length
      offenders.push(`${rel}:${lineNo} import('${spec}') → crosses ${srcWs ?? '(root)'} → ${tgtWs}`)
    }
  }
}

if (offenders.length > 0) {
  console.error('Cross-package relative type-queries found — use import(\'@neutronai/<pkg>/...\'):')
  for (const o of offenders) console.error('  ' + o)
  console.error(`\nTYPE-QUERY GATE: FAILED — ${offenders.length} found`)
  process.exit(1)
}
console.log('TYPE-QUERY GATE (cross-package import() type-queries): 0 found ✅')
