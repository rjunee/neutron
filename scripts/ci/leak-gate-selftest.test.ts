/**
 * Unit G8 (Part A) — self-tests for scripts/ci/leak-gate.sh, the public purity
 * gate that had ZERO tests. (The NUL binary-hiding tripwire is covered
 * separately by leak-gate-nul-tripwire.test.ts; this suite covers the broader
 * vocabulary + structural rules and the clean-tree silence baseline.)
 *
 * Every case runs the REAL gate against a THROWAWAY fixture tree we populate —
 * never the real repo — so the assertions don't depend on the repo staying
 * clean. A fixture with PLANTED findings must FAIL (naming the right rule); a
 * clean fixture must be SILENT.
 *
 * NOTE: the forbidden tokens this suite plants are assembled from FRAGMENTS at
 * runtime (below), never written as literals, so this test's own source never
 * trips the very gate it drives. The throwaway fixtures still receive the real,
 * fully-assembled tokens — only this source file stays clean.
 */
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const LEAK_GATE = fileURLToPath(new URL('./leak-gate.sh', import.meta.url))
const REPO_LICENSE = fileURLToPath(new URL('../../LICENSE', import.meta.url))

// Retired / forbidden tokens, fragment-assembled (see file header).
const T2 = 'ten' + 'ant' // retired multi-org vocab root
const CODE_TOKEN = `${T2}_slug` // a retired code identifier
const HOSTED = 'neutron' + '.' + 'computer' // hosted product domain (rule stays armed)

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

/** A tree the gate passes cleanly: real Apache LICENSE + one innocuous source. */
function freshTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'leak-gate-selftest-'))
  copyFileSync(REPO_LICENSE, join(dir, 'LICENSE'))
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'clean.ts'), 'export const ok = true\n')
  return dir
}

describe('G8 leak-gate — clean baseline', () => {
  test('a clean fixture tree is SILENT', () => {
    const dir = freshTree()
    try {
      const { code, out } = runGate(dir)
      expect(out).toContain('LEAK GATE: SILENT')
      expect(code).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('G8 leak-gate — planted findings FAIL', () => {
  test('a retired-vocab CODE token trips the code rule', () => {
    const dir = freshTree()
    try {
      // A retired live-surface identifier that must never re-enter the tree.
      writeFileSync(join(dir, 'src', 'db.ts'), `export const key = ${CODE_TOKEN}\n`)
      const { code, out } = runGate(dir)
      expect(out).toContain(`[${T2}-code]`)
      expect(out).toContain('LEAK GATE: FAIL')
      expect(code).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('retired-vocab PROSE in a comment trips the Tier-2 prose rule', () => {
    const dir = freshTree()
    try {
      writeFileSync(join(dir, 'src', 'note.ts'), `// each ${T2} gets an isolated db\nexport const x = 1\n`)
      const { code, out } = runGate(dir)
      expect(out).toContain(`[${T2}-word]`)
      expect(code).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the hosted product domain trips the self-host-only rule', () => {
    const dir = freshTree()
    try {
      writeFileSync(join(dir, 'src', 'url.ts'), `export const host = "https://app.${HOSTED}"\n`)
      const { code, out } = runGate(dir)
      expect(out).toContain('[neutron-computer]')
      expect(code).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a NUL-carrying source (token hidden from grep) trips binary-hidden', () => {
    const dir = freshTree()
    try {
      // A raw NUL makes grep -I skip the file; the tripwire must still catch it.
      writeFileSync(join(dir, 'src', 'sneaky.ts'), `const k = "a\x00${CODE_TOKEN}"\n`)
      const { code, out } = runGate(dir)
      expect(out).toContain('[binary-hidden]')
      expect(code).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a forbidden Managed structural path trips forbidden-path', () => {
    const dir = freshTree()
    try {
      mkdirSync(join(dir, 'signup'))
      writeFileSync(join(dir, 'signup', 'index.ts'), 'export const x = 1\n')
      const { code, out } = runGate(dir)
      expect(out).toContain('[forbidden-path]')
      expect(code).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a missing/stub LICENSE trips license-stub', () => {
    // No LICENSE copied → the Apache-2.0 check fails.
    const dir = mkdtempSync(join(tmpdir(), 'leak-gate-nolicense-'))
    try {
      mkdirSync(join(dir, 'src'))
      writeFileSync(join(dir, 'src', 'clean.ts'), 'export const ok = true\n')
      const { code, out } = runGate(dir)
      expect(out).toContain('[license-stub]')
      expect(code).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('summary tallies multiple planted findings at once', () => {
    const dir = freshTree()
    try {
      writeFileSync(join(dir, 'src', 'db.ts'), `export const key = ${CODE_TOKEN}\n`)
      writeFileSync(join(dir, 'src', 'url.ts'), `export const host = "${HOSTED}"\n`)
      const { code, out } = runGate(dir)
      expect(out).toContain(`[${T2}-code]`)
      expect(out).toContain('[neutron-computer]')
      expect(out).toMatch(/TOTAL FINDINGS: [1-9]/)
      expect(code).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
