/**
 * Unit G7 — leak-gate binary-hiding tripwire self-test.
 *
 * The leak-gate scans everything through `grep -I`, which SILENTLY skips any
 * file it classifies as binary (i.e. any file containing a raw NUL byte) — so a
 * banned token embedded next to a NUL is invisible to every vocab/PII rule. G7
 * added a `binary-hidden` tripwire that hard-fails on any tracked file carrying
 * a NUL unless it is a known binary-asset class (exempt by extension) or is
 * allowlisted by exact path.
 *
 * This test pins the tripwire's four load-bearing behaviours against a throwaway
 * fixture tree (so it does not depend on the real repo staying clean). It is
 * intentionally NARROW and separately named so it does not collide with the
 * broader leak-gate fixture suite that unit G8 adds.
 *
 * NOTE: every NUL used below is written via the `\x00` escape — this test's own
 * source stays pure text so it can never trip the very tripwire it exercises.
 */
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const LEAK_GATE = fileURLToPath(new URL('./leak-gate.sh', import.meta.url))
const REPO_LICENSE = fileURLToPath(new URL('../../LICENSE', import.meta.url))

/** Run the gate against `dir`; return { code, out } (out = stdout+stderr). */
function runGate(dir: string): { code: number; out: string } {
  try {
    const out = execFileSync('bash', [LEAK_GATE, '--tree', dir], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, out }
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

/** A minimal tree the gate passes cleanly: real LICENSE + one innocuous source. */
function freshTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'leak-gate-tripwire-'))
  copyFileSync(REPO_LICENSE, join(dir, 'LICENSE'))
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'clean.ts'), 'export const ok = true\n')
  return dir
}

describe('G7 leak-gate binary-hiding tripwire', () => {
  test('a clean fixture tree is SILENT (baseline)', () => {
    const dir = freshTree()
    try {
      const { code, out } = runGate(dir)
      expect(out).toContain('LEAK GATE: SILENT')
      expect(code).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('FIRES on a source file that carries a raw NUL byte', () => {
    const dir = freshTree()
    try {
      // A .ts file with a real NUL byte: grep would skip it, so the tripwire
      // must catch it. `\x00` writes exactly one 0x00 byte to the fixture.
      writeFileSync(join(dir, 'src', 'hidden.ts'), 'const k = "a\x00b"\n')
      const { code, out } = runGate(dir)
      expect(out).toContain('[binary-hidden]')
      expect(out).toContain('src/hidden.ts')
      expect(out).toContain('LEAK GATE: FAIL')
      expect(code).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('does NOT fire on a known binary-asset extension (.png) with a NUL', () => {
    const dir = freshTree()
    try {
      // PNG signature bytes, NUL included — a legit binary asset, exempt by ext.
      writeFileSync(
        join(dir, 'src', 'logo.png'),
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00]),
      )
      const { code, out } = runGate(dir)
      expect(out).toContain('LEAK GATE: SILENT')
      expect(out).not.toContain('[binary-hidden]')
      expect(code).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('is FAIL-CLOSED: an unknown extension with a NUL still trips', () => {
    const dir = freshTree()
    try {
      writeFileSync(join(dir, 'src', 'mystery.weirdext'), 'A\x00B\n')
      const { code, out } = runGate(dir)
      expect(out).toContain('[binary-hidden]')
      expect(out).toContain('src/mystery.weirdext')
      expect(code).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
