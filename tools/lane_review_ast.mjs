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
const FINDINGS_EXIT = 10

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

function sourceAt(ref, file) {
  if (!pathsAt(ref).has(file)) return undefined
  return sourcesAt(ref, [file]).get(file)
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

function parseJsonAt(ref, file) {
  const source = sourceAt(ref, file)
  if (source === undefined) return undefined
  try {
    return JSON.parse(source)
  } catch {
    die(`${file} could not be parsed as JSON`)
  }
}

function workspacePatterns(manifest) {
  if (Array.isArray(manifest?.workspaces)) return manifest.workspaces
  if (Array.isArray(manifest?.workspaces?.packages)) return manifest.workspaces.packages
  return []
}

function workspacePattern(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replaceAll('**', '\0').replaceAll('*', '[^/]*').replaceAll('\0', '.*')}$`)
}

function exportTarget(value) {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return undefined
  for (const condition of ['bun', 'import', 'require', 'default', 'types']) {
    const target = exportTarget(value[condition])
    if (target) return target
  }
  return undefined
}

function workspacePaths(ref) {
  const rootManifest = parseJsonAt(ref, 'package.json')
  const patterns = workspacePatterns(rootManifest)
    .filter((pattern) => typeof pattern === 'string')
    .map(workspacePattern)
  if (patterns.length === 0) return {}

  const mappings = {}
  const packageFiles = [...pathsAt(ref)]
    .filter((file) => file !== 'package.json' && file.endsWith('/package.json'))
    .sort()
  for (const packageFile of packageFiles) {
    const directory = path.posix.dirname(packageFile)
    if (!patterns.some((pattern) => pattern.test(directory))) continue
    const manifest = parseJsonAt(ref, packageFile)
    if (typeof manifest?.name !== 'string') continue

    const rootExport = exportTarget(
      typeof manifest.exports === 'string' ? manifest.exports : manifest.exports?.['.'],
    )
    const entry = rootExport ?? manifest.module ?? manifest.main ?? manifest.types ?? './index.ts'
    if (typeof entry === 'string') {
      mappings[manifest.name] = [path.posix.join(directory, entry)]
    }

    if (manifest.exports && typeof manifest.exports === 'object') {
      for (const [subpath, value] of Object.entries(manifest.exports)) {
        if (!subpath.startsWith('./') || subpath === '.') continue
        const target = exportTarget(value)
        if (target) mappings[`${manifest.name}/${subpath.slice(2)}`] = [path.posix.join(directory, target)]
      }
    }
    mappings[`${manifest.name}/*`] ??= [`${directory}/*`]
  }
  return mappings
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
    baseUrl: VIRTUAL_ROOT,
    paths: workspacePaths(ref),
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
    if (program.getSyntacticDiagnostics(sourceFile).length > 0) {
      die(`${file} could not be parsed as JavaScript/TypeScript`)
    }
    sourceFiles.set(file, sourceFile)
  }

  return { checker: program.getTypeChecker(), host, options, sourceFiles }
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

function modulePathForSpecifier(program, specifier) {
  const symbol = program.checker.getSymbolAtLocation(specifier)
  const declaration = symbol?.declarations?.find(ts.isSourceFile)
  if (declaration) return sourcePathOf(declaration)
  if (!ts.isStringLiteralLike(specifier)) return undefined
  const importer = sourcePathOf(specifier)
  if (!importer) return undefined
  const resolved = ts.resolveModuleName(
    specifier.text,
    virtualName(importer),
    program.options,
    program.host,
  ).resolvedModule
  return resolved ? repoPath(resolved.resolvedFileName) : undefined
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

function addRecordsToSymbolMap(map, symbol, records) {
  for (const record of records ?? []) addToSymbolMap(map, symbol, record)
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

function exportedRecordRoutes(branch, records) {
  const recordsByTarget = new Map()
  for (const record of records) {
    addToSymbolMap(recordsByTarget, unalias(branch.checker, record.symbol), record)
  }

  const routes = new Map()
  for (const [modulePath, sourceFile] of branch.sourceFiles) {
    const moduleRecords = new Map()
    for (const [name, symbol] of exportsOf(branch.checker, sourceFile)) {
      const matching = recordsByTarget.get(unalias(branch.checker, symbol))
      if (matching) moduleRecords.set(name, matching)
    }
    if (moduleRecords.size > 0) routes.set(modulePath, moduleRecords)
  }
  return routes
}

function recordsForSpecifier(branch, routes, specifier) {
  const modulePath = modulePathForSpecifier(branch, specifier)
  return modulePath ? routes.get(modulePath) : undefined
}

function unwrapExpression(node) {
  let current = node
  while (
    ts.isAwaitExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression
  }
  return current
}

function loaderSpecifier(checker, node) {
  const expression = unwrapExpression(node)
  if (!ts.isCallExpression(expression) || expression.arguments.length !== 1) return undefined
  const callee = expression.expression
  const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword
  const requireSymbol = ts.isIdentifier(callee) && callee.text === 'require'
    ? checker.getSymbolAtLocation(callee)
    : undefined
  const isRequire = ts.isIdentifier(callee) && callee.text === 'require' &&
    !requireSymbol?.declarations?.length
  if (!isDynamicImport && !isRequire) return undefined
  const specifier = expression.arguments[0]
  return ts.isStringLiteralLike(specifier) ? specifier : undefined
}

function recordsForLoader(branch, routes, node) {
  const specifier = loaderSpecifier(branch.checker, node)
  return specifier ? recordsForSpecifier(branch, routes, specifier) : undefined
}

function recordsForLoaderAccess(branch, routes, node) {
  const expression = unwrapExpression(node)
  if (ts.isPropertyAccessExpression(expression)) {
    return recordsForLoader(branch, routes, expression.expression)?.get(expression.name.text)
  }
  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression &&
    ts.isStringLiteralLike(expression.argumentExpression)
  ) {
    return recordsForLoader(branch, routes, expression.expression)
      ?.get(expression.argumentExpression.text)
  }
  return undefined
}

function bindObjectPattern(checker, directBindings, pattern, moduleRecords) {
  for (const element of pattern.elements) {
    if (element.dotDotDotToken || !ts.isIdentifier(element.name)) continue
    const importedName = element.propertyName && ts.isPropertyName(element.propertyName)
      ? element.propertyName.getText().replace(/^['"]|['"]$/g, '')
      : element.name.text
    addRecordsToSymbolMap(
      directBindings,
      checker.getSymbolAtLocation(element.name),
      moduleRecords.get(importedName),
    )
  }
}

function collectCallers(branch, records, changedPaths) {
  const routes = exportedRecordRoutes(branch, records)
  const directBindings = new Map()
  const namespaceBindings = new Map()
  for (const sourceFile of branch.sourceFiles.values()) {
    function collectBindings(node) {
      if (ts.isImportDeclaration(node) && node.importClause && !node.importClause.isTypeOnly) {
        const moduleRecords = recordsForSpecifier(branch, routes, node.moduleSpecifier)
        if (moduleRecords) {
          const clause = node.importClause
          if (clause.name) {
            addRecordsToSymbolMap(
              directBindings,
              branch.checker.getSymbolAtLocation(clause.name),
              moduleRecords.get('default'),
            )
          }
          if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
            for (const element of clause.namedBindings.elements) {
              if (element.isTypeOnly) continue
              const importedName = (element.propertyName ?? element.name).text
              addRecordsToSymbolMap(
                directBindings,
                branch.checker.getSymbolAtLocation(element.name),
                moduleRecords.get(importedName),
              )
            }
          } else if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
            const symbol = branch.checker.getSymbolAtLocation(clause.namedBindings.name)
            if (symbol) namespaceBindings.set(symbol, moduleRecords)
          }
        }
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        !node.isTypeOnly &&
        ts.isExternalModuleReference(node.moduleReference) &&
        node.moduleReference.expression
      ) {
        const moduleRecords = recordsForSpecifier(branch, routes, node.moduleReference.expression)
        const symbol = branch.checker.getSymbolAtLocation(node.name)
        if (moduleRecords && symbol) namespaceBindings.set(symbol, moduleRecords)
      } else if (ts.isVariableDeclaration(node) && node.initializer) {
        const moduleRecords = recordsForLoader(branch, routes, node.initializer)
        if (moduleRecords) {
          if (ts.isIdentifier(node.name)) {
            const symbol = branch.checker.getSymbolAtLocation(node.name)
            if (symbol) namespaceBindings.set(symbol, moduleRecords)
          } else if (ts.isObjectBindingPattern(node.name)) {
            bindObjectPattern(branch.checker, directBindings, node.name, moduleRecords)
          }
        } else if (ts.isIdentifier(node.name)) {
          addRecordsToSymbolMap(
            directBindings,
            branch.checker.getSymbolAtLocation(node.name),
            recordsForLoaderAccess(branch, routes, node.initializer),
          )
        }
      }
      ts.forEachChild(node, collectBindings)
    }
    collectBindings(sourceFile)
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
      if (!insideAddedDefinition(node, definitions)) {
        for (const record of recordsForLoaderAccess(branch, routes, node) ?? []) {
          record.callers.add(callerPath)
        }
      }
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
            for (const record of moduleRecords?.get(node.parent.name.text) ?? []) {
              record.callers.add(callerPath)
            }
          } else if (
            ts.isElementAccessExpression(node.parent) &&
            node.parent.expression === node &&
            ts.isStringLiteral(node.parent.argumentExpression)
          ) {
            const moduleRecords = namespaceBindings.get(symbol)
            for (const record of moduleRecords?.get(node.parent.argumentExpression.text) ?? []) {
              record.callers.add(callerPath)
            }
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
    console.log('--- no new exported symbols — nothing to verify (wiring N/A)')
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
  if (findings > 0) process.exitCode = FINDINGS_EXIT
}

const [mode, baseRef, branchRef, ...rest] = process.argv.slice(2)
if (mode === 'analyze' && baseRef && branchRef) runAnalyze(baseRef, branchRef, rest)
else die('internal analyzer usage error')
