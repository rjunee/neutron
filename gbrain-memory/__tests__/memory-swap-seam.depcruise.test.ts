/**
 * RA5 (invariant I2) — the `memory-backend-swap-seam` depcruise rule has TEETH.
 *
 * The rule's JOB is to make "a stray GBrain op call from a product module fails
 * depcruise" a compile-time guarantee (plan §RA5). depcruise sees IMPORT EDGES,
 * not call sites, so the ban works structurally: the ONLY surface that can name
 * a raw op (`put_page` / `add_link` / `get_links`) is `McpClient.call(name,
 * args)`, which lives in the NON-permitted internal `gbrain-memory/mcp-client.ts`
 * (alongside the stdio transport + adapters). The permitted contract files
 * (`memory-store.ts`, `agent-tool.ts`) expose only typed `MemoryStore` methods,
 * so a product module cannot obtain or call a raw-op transport without importing
 * a banned internal — which this rule rejects.
 *
 * This test proves both directions against the REAL config by planting probe
 * modules in `gateway/` — a non-exempt `from` that actually declares
 * `@neutronai/gbrain-memory` as a dependency, so the probe's import RESOLVES to
 * a real edge the rule can evaluate (the composition tier is exactly where a
 * stray memory call would realistically originate, since it wires the store) —
 * and running dependency-cruiser:
 *   1. REJECT — a product module that imports the transport and calls
 *      `client.call('put_page', …)` trips `memory-backend-swap-seam`.
 *   2. PASS  — a product module that imports ONLY the neutral contract
 *      (`memory-store.ts`) and mentions the op names in a COMMENT does NOT trip
 *      the rule (proving the guard targets real edges, not prose — the concern
 *      the RA5 spec calls out for scribe/write-to-gbrain.ts + GBrainSyncHook).
 *
 * The probes are written + removed per test (afterEach), so the tree stays
 * clean even on failure.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
