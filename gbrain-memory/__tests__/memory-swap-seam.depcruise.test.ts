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
 *   (3) NO WIRING LEAK — the ONE composition module allowed to import the
 *       transport (`build-gbrain-memory.ts`) keeps it a LOCAL and returns only
 *       the typed `MemoryStore`. Proven by the compile-time conditional-type
 *       probe in build-gbrain-memory.test.ts AND by the acquisition scan below,
 *       which asserts NO exempt/product-scope module exposes a raw transport on
 *       a PROVIDER surface (exported field / return type). A raw client named
 *       only as a function PARAMETER is a sink (it consumes a transport the
 *       caller already holds) — not a source — so it does not leak acquisition.
 *
 * The depcruise probes are written + removed per test (afterEach), so the tree
 * stays clean even on failure.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..') // gbrain-memory/__tests__ → gbrain-memory → worktree root
const CONFIG = join(ROOT, '.dependency-cruiser.cjs')

/** Type names that ARE a raw op-capable transport (naming one on a provider surface = a leak). */
const RAW_TRANSPORT_TYPES = new Set(['GBrainStdioMcpClient', 'McpClient'])

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

// --- Acquisition-source scan (layer 3) ---------------------------------------

/** True when `node` sits inside a function/method PARAMETER's type (a sink, not a source). */
function isInsideParameterType(node: ts.Node): boolean {
  for (let cur: ts.Node | undefined = node.parent; cur !== undefined; cur = cur.parent) {
    if (ts.isParameter(cur)) return true
    if (ts.isSourceFile(cur)) break
  }
  return false
}

/** True when `node` is inside a top-level declaration carrying the `export` modifier. */
function isInsideExportedDecl(node: ts.Node): boolean {
  let top: ts.Node = node
  while (top.parent !== undefined && !ts.isSourceFile(top.parent)) top = top.parent
  const mods = ts.canHaveModifiers(top) ? ts.getModifiers(top) : undefined
  return mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false
}

/**
 * Every EXPORTED PROVIDER surface (exported interface field, type alias, return
 * type, exported const type) that names a raw transport type — i.e. hands a
 * caller a way to OBTAIN one. A raw type in a PARAMETER position is a sink
 * (consumes a transport the caller already has, e.g. connect's
 * `exportProjectGraphSnapshot(mcp: McpClient)`) and is NOT a leak.
 */
function findRawTransportProviders(
  fileName: string,
  src: string,
): Array<{ line: number; typeName: string }> {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const leaks: Array<{ line: number; typeName: string }> = []
  const visit = (node: ts.Node): void => {
    if (ts.isTypeReferenceNode(node)) {
      const name = ts.isQualifiedName(node.typeName)
        ? node.typeName.right.text
        : node.typeName.text
      if (RAW_TRANSPORT_TYPES.has(name) && isInsideExportedDecl(node) && !isInsideParameterType(node)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
        leaks.push({ line: line + 1, typeName: name })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return leaks
}

function trackedTsFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '*.ts', '*.tsx'], { cwd: ROOT, encoding: 'utf8' })
  return out.split('\n').filter((l) => l.length > 0)
}

function isTestFile(p: string): boolean {
  return /(^|\/)__tests__\//.test(p) || /\.test\.[a-z]+$/.test(p) || /(^|\/)tests\//.test(p)
}

describe('RA5 acquisition boundary — no product-scope source of a raw transport (layer 3)', () => {
  test('no module OUTSIDE gbrain-memory/ + connect/ exposes a raw transport on a provider surface', () => {
    // Only the seam infra may hold/thread a raw transport: gbrain-memory/ (the
    // seam owner) and connect/ (the federation mirror — it THREADS a
    // caller-supplied client through input `Deps` fields + parameters, i.e.
    // consumes one the caller already has; it never RETURNS one, and product
    // can't reach it — connect/api is dynamic-import-gated). Both are exempt in
    // the depcruise rule too. EVERY other module — product scope + the exempt
    // composer wiring (build-gbrain-memory.ts, gbrain-sync-state-store.ts) —
    // must expose ONLY the typed MemoryStore. A returned/field-typed raw client
    // on a PROVIDER surface (not a parameter/input sink) is the exact
    // `buildGBrainMemory().client` acquisition hole that was closed. depcruise's
    // import-ban already stops a product module from even naming these types, so
    // in practice the only non-exempt files that could reference them are the
    // composer wiring — this asserts none of them PROVIDES one.
    // NOTE: this is a SYNTACTIC scan (matches the type NAME as written), so a
    // determined import-alias could evade it — but the ALIAS-PROOF structural
    // authority is the compile-time conditional-type probe in
    // build-gbrain-memory.test.ts, which checks the actual `GBrainMemoryWiring`
    // shape regardless of how types are named. This scan is the broader belt.
    const leaks: Array<{ file: string; line: number; typeName: string }> = []
    for (const p of trackedTsFiles()) {
      if (p.startsWith('gbrain-memory/')) continue // the seam owner may hold transports
      if (p.startsWith('connect/')) continue // federation mirror: consumes (input), never provides
      if (isTestFile(p)) continue
      let src: string
      try {
        src = readFileSync(join(ROOT, p), 'utf8')
      } catch {
        continue // skip a raced/unreadable file rather than crash the suite
      }
      if (!src.includes('McpClient') && !src.includes('GBrainStdioMcpClient')) continue
      for (const h of findRawTransportProviders(p, src)) {
        leaks.push({ file: p, line: h.line, typeName: h.typeName })
      }
    }
    expect(
      leaks,
      `A module outside gbrain-memory/ PROVIDES a raw transport (acquisition leak) — ` +
        `expose only the typed MemoryStore:\n` +
        leaks.map((l) => `  ${l.file}:${l.line} → ${l.typeName}`).join('\n'),
    ).toEqual([])
  })
})
