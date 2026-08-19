#!/usr/bin/env bun

// Syntax-aware half of lane_review.sh. The TypeScript checker, rather than
// identifier spelling, decides whether a use is bound to a newly exported
// value. That distinction keeps shadows and re-exports from manufacturing a
// caller while retaining aliases, namespace access and class heritage uses.

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import ts from 'typescript'

const MAX_BUFFER = 256 * 1024 * 1024
const VIRTUAL_ROOT = '/__lane_review__'

function die(message) {
  console.error(`lane_review: ${message}`)
  process.exit(2)
}

const rootResult = spawnSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
  maxBuffer: MAX_BUFFER,
})
if (rootResult.status !== 0) die('could not find the repository root')
const REPO_ROOT = rootResult.stdout.trim()

function git(args, encoding = 'utf8', input) {
  const result = spawnSync('git', args, {
    cwd: REPO_ROOT,
    encoding,
    input,
    maxBuffer: MAX_BUFFER,
  })
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
  const raw = git(['ls-tree', '--full-tree', '-r', '-z', '--name-only', ref], 'buffer')
  paths = new Set(raw.toString('utf8').split('\0').filter(Boolean))
  treeCache.set(ref, paths)
  return paths
}

function sourcesAt(ref, paths) {
  if (paths.length === 0) return new Map()
  const input = Buffer.from(paths.map((file) => `${ref}:${file}\0`).join(''))
  const output = git(['cat-file', '--batch', '-Z'], 'buffer', input)
  const sources = new Map()
  let cursor = 0

  for (const file of paths) {
    const headerEnd = output.indexOf(0, cursor)
    if (headerEnd < 0) die(`could not read ${file} at ${ref}`)
    const header = output.subarray(cursor, headerEnd).toString('utf8')
    const size = Number(header.slice(header.lastIndexOf(' ') + 1))
    if (!Number.isSafeInteger(size)) die(`could not read ${file} at ${ref}`)
    const start = headerEnd + 1
    const end = start + size
    if (end >= output.length || output[end] !== 0) die(`could not read ${file} at ${ref}`)
    sources.set(file, output.subarray(start, end).toString('utf8'))
    cursor = end + 1
  }

  return sources
}

function isSource(file) {
  return /\.(?:[cm]?[jt]s|jsx|tsx)$/.test(file)
}

function isProductionSource(file) {
  return (
    isSource(file) &&
    !/(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\./.test(file)
  )
}

function scriptKind(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (/\.(?:mjs|cjs|js)$/.test(file)) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

function virtualName(file) {
  return `${VIRTUAL_ROOT}/${file}`
}

function repoPath(fileName) {
  const normalized = path.posix.normalize(fileName)
  const prefix = `${VIRTUAL_ROOT}/`
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : undefined
}

function buildProgram(ref) {
  const files = [...pathsAt(ref)].filter(isProductionSource).sort()
  const byPath = sourcesAt(ref, files)
  const byVirtualName = new Map(
    [...byPath].map(([file, source]) => [virtualName(file), source]),
  )
  const directories = new Set([VIRTUAL_ROOT])
  for (const fileName of byVirtualName.keys()) {
    let directory = path.posix.dirname(fileName)
    while (directory.startsWith(VIRTUAL_ROOT)) {
      directories.add(directory)
      if (directory === VIRTUAL_ROOT) break
      directory = path.posix.dirname(directory)
    }
  }

  const options = {
    allowImportingTsExtensions: true,
    allowJs: true,
    checkJs: false,
    jsx: ts.JsxEmit.Preserve,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    noLib: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.Latest,
  }
  const host = ts.createCompilerHost(options, true)
  host.getCurrentDirectory = () => VIRTUAL_ROOT
  host.fileExists = (fileName) => byVirtualName.has(path.posix.normalize(fileName))
  host.readFile = (fileName) => byVirtualName.get(path.posix.normalize(fileName))
  host.directoryExists = (directory) => directories.has(path.posix.normalize(directory))
  host.getDirectories = (directory) => {
    const prefix = `${path.posix.normalize(directory)}/`
    return [...directories]
      .filter((candidate) => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes('/'))
      .map((candidate) => path.posix.basename(candidate))
  }
  host.realpath = (fileName) => path.posix.normalize(fileName)
  host.getSourceFile = (fileName, languageVersion) => {
    const normalized = path.posix.normalize(fileName)
    const source = byVirtualName.get(normalized)
    if (source === undefined) return undefined
    return ts.createSourceFile(normalized, source, languageVersion, true, scriptKind(normalized))
  }

  const program = ts.createProgram({
    rootNames: [...byVirtualName.keys()],
    options,
    host,
  })
  const sourceFiles = new Map()
  for (const sourceFile of program.getSourceFiles()) {
    const file = repoPath(sourceFile.fileName)
    if (file === undefined) continue
    if (sourceFile.parseDiagnostics.length > 0) {
      die(`${file} could not be parsed as JavaScript/TypeScript`)
    }
    sourceFiles.set(file, sourceFile)
  }

  return { checker: program.getTypeChecker(), sourceFiles }
}

function unalias(checker, symbol) {
  if (!(symbol.flags & ts.SymbolFlags.Alias)) return symbol
  const target = checker.getAliasedSymbol(symbol)
  return target.flags & ts.SymbolFlags.Unknown ? symbol : target
}

function isRuntimeExport(checker, symbol) {
  const target = unalias(checker, symbol)
  if (target.flags & ts.SymbolFlags.Value) return true
  return symbol.declarations?.some((declaration) => ts.isExportAssignment(declaration)) ?? false
}

function exportsOf(checker, sourceFile) {
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile)
  const result = new Map()
  if (!moduleSymbol) return result
  for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
    if (isRuntimeExport(checker, symbol)) result.set(symbol.getName(), symbol)
  }
  return result
}

function sourcePathOf(node) {
  return repoPath(node.getSourceFile().fileName)
}

function addedExports(base, branch, changedPaths) {
  const added = []
  for (const modulePath of changedPaths) {
    const currentFile = branch.sourceFiles.get(modulePath)
    if (!currentFile) continue
    const current = exportsOf(branch.checker, currentFile)
    const previousFile = base.sourceFiles.get(modulePath)
    const previous = previousFile ? exportsOf(base.checker, previousFile) : new Map()
    for (const [name, symbol] of current) {
      if (!previous.has(name)) {
        let displayName = name
        if (name === 'default') {
          const namedDeclaration = symbol.declarations?.find(
            (declaration) =>
              (ts.isFunctionDeclaration(declaration) || ts.isClassDeclaration(declaration)) &&
              declaration.name,
          )
          if (namedDeclaration?.name) displayName = namedDeclaration.name.text
        }
        added.push({ callers: new Set(), displayName, modulePath, name, symbol })
      }
    }
  }
  return added.sort((left, right) =>
    left.name.localeCompare(right.name) || left.modulePath.localeCompare(right.modulePath),
  )
}

function modulePathForSpecifier(checker, specifier) {
  const symbol = checker.getSymbolAtLocation(specifier)
  const declaration = symbol?.declarations?.find(ts.isSourceFile)
  return declaration ? sourcePathOf(declaration) : undefined
}

function addToSymbolMap(map, symbol, record) {
  if (!symbol) return
  let records = map.get(symbol)
  if (!records) {
    records = new Set()
    map.set(symbol, records)
  }
  records.add(record)
}

function isInside(node, ancestor) {
  return node.getSourceFile() === ancestor.getSourceFile() &&
    node.getStart() >= ancestor.getStart() && node.getEnd() <= ancestor.getEnd()
}

function isRuntimeHeritageReference(identifier) {
  for (let ancestor = identifier.parent; ancestor; ancestor = ancestor.parent) {
    if (ts.isExpressionWithTypeArguments(ancestor) && isInside(identifier, ancestor.expression)) {
      const heritage = ancestor.parent
      return (
        ts.isHeritageClause(heritage) &&
        heritage.token === ts.SyntaxKind.ExtendsKeyword &&
        (ts.isClassDeclaration(heritage.parent) || ts.isClassExpression(heritage.parent))
      )
    }
    if (ts.isStatement(ancestor)) break
  }
  return false
}

function isRuntimeReference(identifier) {
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
  if (isRuntimeHeritageReference(identifier)) return true
  for (let ancestor = parent; ancestor && !ts.isStatement(ancestor); ancestor = ancestor.parent) {
    if (ts.isTypeNode(ancestor)) return false
  }
  return true
}

function insideAddedDefinition(node, definitions) {
  for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
    if (definitions.has(ancestor)) return true
  }
  return false
}

function definitionNodes(checker, records, changedPaths) {
  const changed = new Set(changedPaths)
  const definitions = new Set()
  for (const record of records) {
    const target = unalias(checker, record.symbol)
    for (const declaration of target.declarations ?? []) {
      if (
        changed.has(sourcePathOf(declaration)) &&
        !ts.isExportSpecifier(declaration) &&
        !ts.isImportSpecifier(declaration)
      ) {
        definitions.add(declaration)
      }
    }
  }
  return definitions
}

function collectCallers(branch, records, changedPaths) {
  const byModule = new Map()
  for (const record of records) {
    let moduleRecords = byModule.get(record.modulePath)
    if (!moduleRecords) {
      moduleRecords = new Map()
      byModule.set(record.modulePath, moduleRecords)
    }
    moduleRecords.set(record.name, record)
  }

  const directBindings = new Map()
  const namespaceBindings = new Map()
  for (const sourceFile of branch.sourceFiles.values()) {
    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || !statement.importClause || statement.importClause.isTypeOnly) {
        continue
      }
      const modulePath = modulePathForSpecifier(branch.checker, statement.moduleSpecifier)
      const moduleRecords = modulePath ? byModule.get(modulePath) : undefined
      if (!moduleRecords) continue
      const clause = statement.importClause
      if (clause.name) {
        const record = moduleRecords.get('default')
        if (record) addToSymbolMap(directBindings, branch.checker.getSymbolAtLocation(clause.name), record)
      }
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          if (element.isTypeOnly) continue
          const importedName = (element.propertyName ?? element.name).text
          const record = moduleRecords.get(importedName)
          if (record) addToSymbolMap(directBindings, branch.checker.getSymbolAtLocation(element.name), record)
        }
      } else if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        const symbol = branch.checker.getSymbolAtLocation(clause.namedBindings.name)
        if (symbol) namespaceBindings.set(symbol, moduleRecords)
      }
    }
  }

  const localTargets = new Map()
  for (const record of records) {
    addToSymbolMap(localTargets, unalias(branch.checker, record.symbol), record)
    for (const declaration of record.symbol.declarations ?? []) {
      const name = 'name' in declaration ? declaration.name : undefined
      if (name && ts.isIdentifier(name)) {
        const symbol = branch.checker.getSymbolAtLocation(name)
        if (symbol) addToSymbolMap(localTargets, unalias(branch.checker, symbol), record)
      }
    }
  }
  const definitions = definitionNodes(branch.checker, records, changedPaths)

  for (const [callerPath, sourceFile] of branch.sourceFiles) {
    function visit(node) {
      if (ts.isIdentifier(node) && isRuntimeReference(node) && !insideAddedDefinition(node, definitions)) {
        const symbol = branch.checker.getSymbolAtLocation(node)
        if (symbol) {
          for (const record of directBindings.get(symbol) ?? []) record.callers.add(callerPath)
          const target = unalias(branch.checker, symbol)
          for (const record of localTargets.get(target) ?? []) {
            if (record.modulePath === callerPath) record.callers.add(callerPath)
          }

          if (ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node) {
            const moduleRecords = namespaceBindings.get(symbol)
            const record = moduleRecords?.get(node.parent.name.text)
            if (record) record.callers.add(callerPath)
          } else if (
            ts.isElementAccessExpression(node.parent) &&
            node.parent.expression === node &&
            ts.isStringLiteral(node.parent.argumentExpression)
          ) {
            const moduleRecords = namespaceBindings.get(symbol)
            const record = moduleRecords?.get(node.parent.argumentExpression.text)
            if (record) record.callers.add(callerPath)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
}

function runAnalyze(baseRef, branchRef, changedPaths) {
  const productionPaths = changedPaths.filter(isProductionSource)
  const base = buildProgram(baseRef)
  const branch = buildProgram(branchRef)
  const records = addedExports(base, branch, productionPaths)

  if (records.length === 0) {
    console.log('--- no new exported symbols — nothing to verify; branch edits existing code paths (wiring N/A)')
    return
  }

  collectCallers(branch, records, productionPaths)
  console.log(`--- new exported symbols: ${records.map((record) => record.displayName).join(' ')}`)
  let findings = 0
  for (const record of records) {
    const callers = [...record.callers].sort()
    if (callers.length === 0) {
      console.log(`  FINDING: ${record.displayName} has NO non-test production caller — green-and-unwired.`)
      findings += 1
    } else {
      console.log(`  ok: ${record.displayName} called by ${callers.join(' ')}`)
    }
  }
  if (findings > 0) process.exitCode = 1
}

const [mode, baseRef, branchRef, ...rest] = process.argv.slice(2)
if (mode === 'analyze' && baseRef && branchRef) runAnalyze(baseRef, branchRef, rest)
else die('internal analyzer usage error')
