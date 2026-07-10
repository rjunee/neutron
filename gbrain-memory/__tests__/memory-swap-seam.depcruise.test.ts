/**
 * RA5 (invariant I2) — the memory swap-seam ACQUISITION BOUNDARY.
 *
 * THE ENFORCED INVARIANT: no product-scope module can OBTAIN a raw GBrain
 * transport instance. Because a product module can't get a transport AT ALL, it
 * can't call ANY raw op on one — literal OR dynamically computed
 * (`client.call([...].join('_'))`). The dynamic-op case is prevented HERE, by
 * the acquisition boundary, not by the source-text op-name scanner (which is
 * secondary defense-in-depth — see raw-op-seam-ban.test.ts).
 *
 * The boundary rests on THREE real, tested layers:
 *   (1) TYPE-SEAL — `GBrainStdioMcpClient` / `McpClient` (the only surfaces that
 *       can name + call a raw op) are internal to `gbrain-memory/`.
 *   (2) IMPORT-BAN — the `memory-backend-swap-seam` depcruise rule forbids a
 *       product module importing them (or any adapter / the stdio transport).
 *       Proven by the REJECT probe below.
 *   (3) NO WIRING LEAK / NO LAUNDERING — the composition module allowed to
 *       import the transport (`build-gbrain-memory.ts`) keeps it a LOCAL and
 *       returns only the typed `MemoryStore` (compile-time conditional-type
 *       probe in build-gbrain-memory.test.ts). AND the acquisition scan below
 *       asserts NONE of the files that can even NAME the sealed type (connect/ +
 *       the two composer wiring files — the complete set, since depcruise blocks
 *       everyone else) exposes it on a PROVIDER surface (exported value / return
 *       type / public field) or RE-EXPORTS the type. connect/ is scanned like
 *       everything else (no blanket exemption — that was the laundering hole): a
 *       raw client named only as a PARAMETER or interface input field is a sink
 *       (the caller supplies it) and is allowed; anything obtainable is flagged.
 *       Alias resolution uses the TS type-CHECKER, so an aliased re-export
 *       (`export type T = McpClient; export declare const x: T`) is caught.
 *
 * The depcruise probes are written + removed per test (afterEach), so the tree
 * stays clean even on failure.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..') // gbrain-memory/__tests__ → gbrain-memory → worktree root
const CONFIG = join(ROOT, '.dependency-cruiser.cjs')

const REJECT_REL = 'gateway/__ra5_seam_probe_reject__.ts'
const PASS_REL = 'gateway/__ra5_seam_probe_pass__.ts'
const REJECT_ABS = join(ROOT, REJECT_REL)
const PASS_ABS = join(ROOT, PASS_REL)

const RULE = 'memory-backend-swap-seam'

interface Violation {
  from: string
  to: string
  rule: { name: string; severity: string }
}

/** Cruise a single planted file with the REAL config; return its violations. */
function cruiseViolations(relPath: string): Violation[] {
  let stdout = ''
  try {
    stdout = execFileSync(
      'bunx',
      ['depcruise', '--config', CONFIG, '--output-type', 'json', relPath],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
  } catch (err) {
    // depcruise exits non-zero when it finds error-severity violations; the JSON
    // report is still written to stdout, so recover it from the thrown error.
    const e = err as { stdout?: Buffer | string }
    stdout = e.stdout ? e.stdout.toString() : ''
  }
  const parsed = JSON.parse(stdout) as { summary?: { violations?: Violation[] } }
  return parsed.summary?.violations ?? []
}

afterEach(() => {
  rmSync(REJECT_ABS, { force: true })
  rmSync(PASS_ABS, { force: true })
})

describe('RA5 memory-backend-swap-seam rule (adversarial)', () => {
  test('REJECTS a product module that names a raw GBrain op via the transport', () => {
    writeFileSync(
      REJECT_ABS,
      // A stray backend op call from a non-exempt module — the exact thing RA5
      // §(b) requires to fail. Importing the transport is the only way to name a
      // raw op, and that import is banned outside gbrain-memory/ + connect/.
      `import { GBrainStdioMcpClient } from '@neutronai/gbrain-memory/gbrain-stdio-client.ts'\n` +
        `export async function stray(): Promise<unknown> {\n` +
        `  const client = new GBrainStdioMcpClient()\n` +
        `  return client.call('put_page', { slug: 'x', content: 'y' })\n` +
        `}\n`,
    )
    const seam = cruiseViolations(REJECT_REL).filter(
      (v) => v.rule.name === RULE && v.from === REJECT_REL,
    )
    expect(seam.length).toBeGreaterThan(0)
    expect(seam[0]!.to).toMatch(/^gbrain-memory\//)
  })

  test('PASSES the permitted MemoryStore import with op-names in a COMMENT (prose-safe)', () => {
    writeFileSync(
      PASS_ABS,
      // Legit: only the neutral contract is imported. The op names below appear
      // ONLY in this comment (mirroring scribe/write-to-gbrain.ts + GBrainSyncHook)
      // and must NOT trip the rule: put_page, add_link, get_links.
      `import { isGbrainBinaryMissingError } from '@neutronai/gbrain-memory/memory-store.ts'\n` +
        `export const ok = isGbrainBinaryMissingError\n`,
    )
    const seam = cruiseViolations(PASS_REL).filter(
      (v) => v.rule.name === RULE && v.from === PASS_REL,
    )
    expect(seam).toEqual([])
  })
})

// --- Acquisition-source scan (layer 3): NO provider of a raw transport --------
//
// COMPLETENESS. The ONLY files that can NAME the sealed transport type
// (`McpClient` / `GBrainStdioMcpClient`) are the ones the depcruise import-ban
// lets import gbrain-memory internals: gbrain-memory/ itself (the seam owner,
// excluded here) plus connect/ and the two composer wiring files. Every other
// module is blocked from importing the type, so it can obtain a transport ONLY
// if one of THESE files hands it out (as a value, or by re-exporting the type
// so a downstream module could name it). connect/ is NO LONGER blanket-exempt —
// it is scanned with the same position rule as everything else, which closes
// the laundering channel (a connect file re-exporting the type + exposing a
// value). Scanning exactly this set is therefore complete.
//
// PROVIDER (FLAGGED) = an obtainable value or a type re-export: exported const/
// var, function/method/getter return type, exported class PUBLIC field, exported
// type-alias, or `export {…}` whose type resolves to the sealed transport.
// SINK (ALLOWED) = a parameter or an interface input field: the caller supplies
// the client (connect's `exportProjectGraphSnapshot(mcp: McpClient)` +
// `ImportSharedProjectMemoryDeps.memory`). Alias resolution uses the TS
// type-CHECKER (symbol origin), so `export type T = McpClient; export declare
// const x: T` is caught by following T to its origin declaration — name-level
// aliasing cannot evade it.

const SEALED_TRANSPORT_ORIGINS = ['gbrain-memory/mcp-client.ts', 'gbrain-memory/gbrain-stdio-client.ts']

interface Leak {
  file: string
  line: number
  kind: string
}

function trackedTsFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '*.ts', '*.tsx'], { cwd: ROOT, encoding: 'utf8' })
  return out.split('\n').filter((l) => l.length > 0)
}

function isTestFile(p: string): boolean {
  return /(^|\/)__tests__\//.test(p) || /\.test\.[a-z]+$/.test(p) || /(^|\/)tests\//.test(p)
}

function loadCompilerOptions(): ts.CompilerOptions {
  const read = ts.readConfigFile(join(ROOT, 'tsconfig.base.json'), ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, ROOT)
  return { ...parsed.options, noEmit: true, skipLibCheck: true }
}

/** A symbol (following import aliases) that IS the sealed transport, by ORIGIN declaration. */
function symbolIsSealedTransport(symbol: ts.Symbol | undefined, checker: ts.TypeChecker): boolean {
  if (symbol === undefined) return false
  let s = symbol
  if ((s.flags & ts.SymbolFlags.Alias) !== 0) {
    try {
      s = checker.getAliasedSymbol(s)
    } catch {
      /* not an import alias */
    }
  }
  const name = s.getName()
  if (name !== 'McpClient' && name !== 'GBrainStdioMcpClient') return false
  return (s.getDeclarations() ?? []).some((d) => {
    const f = d.getSourceFile().fileName.replace(/\\/g, '/')
    return SEALED_TRANSPORT_ORIGINS.some((o) => f.endsWith(o))
  })
}

/**
 * Does `type` (resolved through aliases / generics / unions / object fields)
 * expose the sealed transport as an OBTAINABLE value? Bounded to avoid recursive
 * types. Function-typed object members (e.g. `close: () => …`) are skipped —
 * they are not transports.
 */
function typeExposesTransport(
  type: ts.Type | undefined,
  checker: ts.TypeChecker,
  seen: Set<ts.Type>,
  depth: number,
): boolean {
  if (type === undefined || depth > 4 || seen.has(type)) return false
  seen.add(type)
  if (symbolIsSealedTransport(type.aliasSymbol, checker)) return true
  if (symbolIsSealedTransport(type.getSymbol(), checker)) return true
  if (type.isUnionOrIntersection()) {
    return type.types.some((t) => typeExposesTransport(t, checker, seen, depth + 1))
  }
  if ((type.flags & ts.TypeFlags.Object) !== 0) {
    const obj = type as ts.ObjectType
    if ((obj.objectFlags & ts.ObjectFlags.Reference) !== 0) {
      for (const arg of checker.getTypeArguments(type as ts.TypeReference)) {
        if (typeExposesTransport(arg, checker, seen, depth + 1)) return true
      }
    }
    for (const prop of type.getProperties()) {
      const decl = prop.valueDeclaration ?? prop.getDeclarations()?.[0]
      if (decl === undefined) continue
      const pType = checker.getTypeOfSymbolAtLocation(prop, decl)
      if (pType.getCallSignatures().length > 0) continue // a method/fn field is not a transport
      if (typeExposesTransport(pType, checker, seen, depth + 1)) return true
    }
  }
  return false
}

function hasExportModifier(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined
  return mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false
}

function isPublicClassMember(node: ts.ClassElement): boolean {
  if (node.name !== undefined && ts.isPrivateIdentifier(node.name)) return false
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined
  return !(
    mods?.some(
      (m) =>
        m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword,
    ) ?? false
  )
}

/** Provider-position leaks in one source file (interfaces + params are sinks, not scanned). */
function scanSourceForTransportProviders(sf: ts.SourceFile, checker: ts.TypeChecker): Leak[] {
  const rel = ts.sys.resolvePath(sf.fileName).replace(ts.sys.resolvePath(ROOT) + '/', '')
  const leaks: Leak[] = []
  const fresh = () => new Set<ts.Type>()
  const flag = (node: ts.Node, kind: string): void => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
    leaks.push({ file: rel, line: line + 1, kind })
  }
  for (const stmt of sf.statements) {
    // Re-export of the sealed type: `export { McpClient }` / `export type { McpClient as X }`.
    if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const spec of stmt.exportClause.elements) {
        if (symbolIsSealedTransport(checker.getSymbolAtLocation(spec.name), checker)) {
          flag(spec, 're-export of the sealed transport type')
        }
      }
      continue
    }
    if (!hasExportModifier(stmt)) continue
    if (ts.isTypeAliasDeclaration(stmt)) {
      // `export type T = McpClient` (or an alias chain resolving to it) launders the type.
      if (typeExposesTransport(checker.getTypeAtLocation(stmt.type), checker, fresh(), 0)) {
        flag(stmt, 'exported type alias resolves to the sealed transport')
      }
    } else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (typeExposesTransport(checker.getTypeAtLocation(d.name), checker, fresh(), 0)) {
          flag(d, 'exported const/var exposes the sealed transport')
        }
      }
    } else if (ts.isFunctionDeclaration(stmt)) {
      const sig = checker.getSignatureFromDeclaration(stmt)
      if (sig && typeExposesTransport(checker.getReturnTypeOfSignature(sig), checker, fresh(), 0)) {
        flag(stmt, 'exported function returns the sealed transport')
      }
    } else if (ts.isClassDeclaration(stmt)) {
      for (const m of stmt.members) {
        if (!isPublicClassMember(m)) continue
        if (ts.isPropertyDeclaration(m)) {
          if (typeExposesTransport(checker.getTypeAtLocation(m), checker, fresh(), 0)) {
            flag(m, 'exported class public field exposes the sealed transport')
          }
        } else if (ts.isMethodDeclaration(m) || ts.isGetAccessorDeclaration(m)) {
          const sig = checker.getSignatureFromDeclaration(m)
          if (sig && typeExposesTransport(checker.getReturnTypeOfSignature(sig), checker, fresh(), 0)) {
            flag(m, 'exported class public method/getter returns the sealed transport')
          }
        }
      }
    }
  }
  return leaks
}

/** Overlay a single virtual source over the real FS so a fixture resolves real imports. */
function overlayProgram(virtualRel: string, content: string): { checker: ts.TypeChecker; sf: ts.SourceFile } {
  const options = loadCompilerOptions()
  const abs = ts.sys.resolvePath(join(ROOT, virtualRel))
  const host = ts.createCompilerHost(options, true)
  const baseGetSf = host.getSourceFile.bind(host)
  const baseRead = host.readFile.bind(host)
  const baseExists = host.fileExists.bind(host)
  host.fileExists = (f) => ts.sys.resolvePath(f) === abs || baseExists(f)
  host.readFile = (f) => (ts.sys.resolvePath(f) === abs ? content : baseRead(f))
  host.getSourceFile = (f, lang, onErr, should) =>
    ts.sys.resolvePath(f) === abs
      ? ts.createSourceFile(f, content, lang, true, ts.ScriptKind.TS)
      : baseGetSf(f, lang, onErr, should)
  const program = ts.createProgram({ rootNames: [abs], options, host })
  return { checker: program.getTypeChecker(), sf: program.getSourceFile(abs)! }
}

describe('RA5 acquisition boundary — no transport PROVIDER outside gbrain-memory/ (layer 3)', () => {
  test(
    'the only files that may name the transport expose ONLY the typed MemoryStore, never the raw transport',
    () => {
      // The complete set of files that can NAME the sealed type (per the depcruise
      // import-ban exempt `from`s, minus gbrain-memory/ + tests): connect/ + the
      // two composer wiring files. connect/ is scanned like everything else — the
      // blanket exemption that let it launder the type is gone.
      const scanned = trackedTsFiles().filter(
        (p) =>
          !isTestFile(p) &&
          (p.startsWith('connect/') ||
            p === 'gateway/realmode-composer/build-gbrain-memory.ts' ||
            p === 'gateway/realmode-composer/gbrain-sync-state-store.ts'),
      )
      const rootNames = [...scanned, ...SEALED_TRANSPORT_ORIGINS].map((p) => join(ROOT, p))
      const program = ts.createProgram({ rootNames, options: loadCompilerOptions() })
      const checker = program.getTypeChecker()
      const scannedAbs = new Set(scanned.map((p) => ts.sys.resolvePath(join(ROOT, p))))
      const leaks: Leak[] = []
      for (const sf of program.getSourceFiles()) {
        if (!scannedAbs.has(ts.sys.resolvePath(sf.fileName))) continue
        leaks.push(...scanSourceForTransportProviders(sf, checker))
      }
      expect(
        leaks,
        `A file outside gbrain-memory/ PROVIDES or re-exports the raw transport ` +
          `(acquisition leak) — expose only the typed MemoryStore:\n` +
          leaks.map((l) => `  ${l.file}:${l.line} — ${l.kind}`).join('\n'),
      ).toEqual([])
    },
    120000,
  )

  test('FLAGS the exact laundering bypass: connect-scope alias re-export + provider const', () => {
    const { checker, sf } = overlayProgram(
      'connect/__ra5_launder_probe__.ts',
      [
        `import type { McpClient as I } from '@neutronai/gbrain-memory/mcp-client.ts'`,
        `export type T = I`, // (a) re-export the sealed type via alias
        `export declare const transport: T`, // (b) expose an obtainable value of it
      ].join('\n'),
    )
    const kinds = scanSourceForTransportProviders(sf, checker).map((l) => l.kind)
    expect(kinds).toContain('exported type alias resolves to the sealed transport')
    expect(kinds).toContain('exported const/var exposes the sealed transport')
  })

  test('FLAGS a direct `export {…}` re-export of the sealed type', () => {
    const { checker, sf } = overlayProgram(
      'connect/__ra5_reexport_probe__.ts',
      `export type { McpClient } from '@neutronai/gbrain-memory/mcp-client.ts'\n`,
    )
    expect(scanSourceForTransportProviders(sf, checker).map((l) => l.kind)).toContain(
      're-export of the sealed transport type',
    )
  })

  test('FLAGS a function/getter that RETURNS the transport (even wrapped in Promise)', () => {
    const { checker, sf } = overlayProgram(
      'connect/__ra5_return_probe__.ts',
      [
        `import type { McpClient } from '@neutronai/gbrain-memory/mcp-client.ts'`,
        `export declare function getTransport(): Promise<McpClient>`,
      ].join('\n'),
    )
    expect(scanSourceForTransportProviders(sf, checker).map((l) => l.kind)).toContain(
      'exported function returns the sealed transport',
    )
  })

  test('does NOT flag SINK positions: a param + an interface input field (caller supplies the client)', () => {
    const { checker, sf } = overlayProgram(
      'connect/__ra5_sink_probe__.ts',
      [
        `import type { McpClient } from '@neutronai/gbrain-memory/mcp-client.ts'`,
        `export function consume(mcp: McpClient): void { void mcp }`,
        `export interface Deps { memory: McpClient }`,
      ].join('\n'),
    )
    expect(scanSourceForTransportProviders(sf, checker)).toEqual([])
  })
})
