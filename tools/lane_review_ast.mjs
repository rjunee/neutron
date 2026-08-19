#!/usr/bin/env bun

// Syntax-aware half of lane_review.sh. Grep cannot distinguish a reference
// from a comment, string, import or re-export, and line regexes miss valid
// TypeScript export forms. Keep those questions on the TypeScript AST; the
// shell wrapper remains responsible for refs, changed-file policy and output.

import { spawnSync } from 'node:child_process'
import ts from 'typescript'

const MAX_BUFFER = 64 * 1024 * 1024

function die(message) {
  console.error(`lane_review: ${message}`)
  process.exit(2)
}

function git(args, encoding = 'utf8') {
  const result = spawnSync('git', args, { encoding, maxBuffer: MAX_BUFFER })
  if (result.status !== 0) {
    const detail = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString('utf8').trim()
      : result.stderr.trim()
    die(`git ${args[0]} failed${detail ? `: ${detail}` : ''}`)
  }
  return result.stdout
}

const treeCache = new Map()

function pathsAt(ref) {
  let paths = treeCache.get(ref)
  if (paths) return paths
  const raw = git(['ls-tree', '-r', '-z', '--name-only', ref], 'buffer')
  paths = new Set(raw.toString('utf8').split('\0').filter(Boolean))
  treeCache.set(ref, paths)
  return paths
}

function sourceAt(ref, path) {
  if (!pathsAt(ref).has(path)) return undefined
  return git(['show', `${ref}:${path}`])
}

function scriptKind(path) {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs')) {
    return ts.ScriptKind.JS
  }
  return ts.ScriptKind.TS
}

function parse(path, source) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind(path))
  if (file.parseDiagnostics.length > 0) die(`${path} could not be parsed as JavaScript/TypeScript`)
  return file
}

function hasModifier(node, kind) {
  return node.modifiers?.some((modifier) => modifier.kind === kind) ?? false
}

function addBindingNames(name, names) {
  if (ts.isIdentifier(name)) {
    names.add(name.text)
    return
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) addBindingNames(element.name, names)
  }
}

function exportedSymbols(path, source) {
  const names = new Set()
  let opaqueDefault = false
  const file = parse(path, source)

  for (const statement of file.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
        continue
      }
      for (const element of statement.exportClause.elements) {
        if (!element.isTypeOnly) names.add((element.propertyName ?? element.name).text)
      }
      continue
    }

    if (ts.isExportAssignment(statement)) {
      if (ts.isIdentifier(statement.expression)) names.add(statement.expression.text)
      else opaqueDefault = true
      continue
    }

    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue

    if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      if (statement.name) names.add(statement.name.text)
      else if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) opaqueDefault = true
      continue
    }

    if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name)) {
      names.add(statement.name.text)
      continue
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        addBindingNames(declaration.name, names)
      }
    }
  }

  return { names, opaqueDefault }
}

function isSource(path) {
  return /\.(?:[cm]?js|jsx|tsx?)$/.test(path)
}

function isProductionSource(path) {
  return isSource(path) && !/\.test\.|\.spec\.|^tests?\/|__tests__/.test(path)
}

function isReference(identifier) {
  let ancestor = identifier.parent
  while (ancestor && !ts.isStatement(ancestor)) {
    if (ts.isTypeNode(ancestor)) return false
    ancestor = ancestor.parent
  }

  const parent = identifier.parent
  if (!parent) return false
  if (
    ts.isImportClause(parent) ||
    ts.isImportSpecifier(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isImportEqualsDeclaration(parent) ||
    ts.isExportSpecifier(parent) ||
    ts.isExportAssignment(parent)
  ) {
    return false
  }
  if (ts.isPropertyAccessExpression(parent) && parent.name === identifier) return false
  if (ts.isQualifiedName(parent) && parent.right === identifier) return false
  if (ts.isLabeledStatement(parent) || ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) {
    return false
  }
  if (
    'name' in parent &&
    parent.name === identifier &&
    !ts.isShorthandPropertyAssignment(parent) &&
    !ts.isJsxOpeningElement(parent) &&
    !ts.isJsxClosingElement(parent) &&
    !ts.isJsxSelfClosingElement(parent)
  ) {
    return false
  }
  return true
}

function referencesIn(path, source, wanted) {
  const found = new Set()
  const file = parse(path, source)

  function visit(node) {
    if (ts.isIdentifier(node) && wanted.has(node.text) && isReference(node)) found.add(node.text)
    ts.forEachChild(node, visit)
  }

  visit(file)
  return found
}

function runExports(base, branch, paths) {
  const added = new Set()
  for (const path of paths) {
    if (!isSource(path)) continue
    const currentSource = sourceAt(branch, path)
    if (currentSource === undefined) continue
    const current = exportedSymbols(path, currentSource)
    const baseSource = sourceAt(base, path)
    const previous =
      baseSource === undefined ? { names: new Set(), opaqueDefault: false } : exportedSymbols(path, baseSource)
    if (current.opaqueDefault && !previous.opaqueDefault) {
      die(`${path} adds an anonymous default export whose caller cannot be identified`)
    }
    for (const symbol of current.names) {
      if (!previous.names.has(symbol)) added.add(symbol)
    }
  }
  process.stdout.write([...added].sort().join('\n'))
  if (added.size > 0) process.stdout.write('\n')
}

function runCallers(branch, symbols) {
  const wanted = new Set(symbols)
  const grepArgs = ['grep', '-l', '-z', '--full-name', '-w']
  for (const symbol of symbols) grepArgs.push('-e', symbol)
  grepArgs.push(branch, '--', '*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.cjs')
  const result = spawnSync('git', grepArgs, { encoding: 'buffer', maxBuffer: MAX_BUFFER })
  if (result.status !== 0 && result.status !== 1) die(`git grep failed with exit ${result.status}`)
  const prefix = `${branch}:`
  const paths = result.stdout
    .toString('utf8')
    .split('\0')
    .map((path) => (path.startsWith(prefix) ? path.slice(prefix.length) : path))
    .filter((path) => path && isProductionSource(path))

  for (const path of paths) {
    const source = sourceAt(branch, path)
    if (source === undefined) continue
    for (const symbol of referencesIn(path, source, wanted)) {
      process.stdout.write(`${symbol}\t${path}\0`)
    }
  }
}

const [mode, refA, refB, ...rest] = process.argv.slice(2)
if (mode === 'exports' && refA && refB) runExports(refA, refB, rest)
else if (mode === 'callers' && refA && refB) runCallers(refA, [refB, ...rest])
else die('internal analyzer usage error')
