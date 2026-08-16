/**
 * Tests for the governed-repo attributes GATE, by running the real script.
 *
 * The gate is a CLI whose whole contract is its exit code, and the pure planner it calls
 * (`trident/as-built-union-attribute.ts`) is already tested separately. What was NOT tested is the
 * script itself — which is where the accept/reject decision actually lives, and which shipped in
 * #315 without a single test and without a CI line to run it.
 *
 * Every "must pass" case here is paired with a "must fail" one that differs in exactly one thing,
 * so a gate that has been widened into a no-op cannot pass this file.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const GATE = join(dirname(new URL(import.meta.url).pathname), 'check-governed-repo-attributes.ts')
const created: string[] = []

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})

interface Repo {
  /** `.gitattributes` content, or null to omit the file entirely. */
  attributes: string | null
  /** Whether the repo ships the entry-aware driver + its installer. */
  shipsDriver?: boolean
  /** Whether the repo is governed at all. */
  governed?: boolean
}

function repoWith({ attributes, shipsDriver = false, governed = true }: Repo): string {
  const root = mkdtempSync(join(tmpdir(), 'governed-attrs-'))
  created.push(root)
  if (governed) writeFileSync(join(root, 'SPEC.md'), '# spec\n')
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(join(root, 'docs', 'AS_BUILT.md'), '# AS_BUILT\n')
  if (attributes !== null) writeFileSync(join(root, '.gitattributes'), attributes)
  if (shipsDriver) {
    mkdirSync(join(root, 'scripts', 'git'), { recursive: true })
    writeFileSync(join(root, 'scripts', 'git', 'as-built-merge-driver.ts'), '// driver\n')
    writeFileSync(join(root, 'scripts', 'install-merge-drivers.sh'), '# installer\n')
  }
  return root
}

function gate(root: string): { code: number; out: string } {
  const res = Bun.spawnSync(['bun', GATE, root], { stdout: 'pipe', stderr: 'pipe' })
  return {
    code: res.exitCode,
    out: new TextDecoder().decode(res.stdout) + new TextDecoder().decode(res.stderr),
  }
}

describe('the gate accepts a log that is bound to a keep-both rule', () => {
  test('union passes — it is still the correct floor for a repo with no driver', () => {
    expect(gate(repoWith({ attributes: 'docs/AS_BUILT.md merge=union\n' })).code).toBe(0)
  })

  test('the entry-aware driver passes WHEN THE REPO SHIPS IT', () => {
    // The change this test exists for. #315 rejected every tracked custom driver, on the
    // measurably false premise that git treats a declared-but-unconfigured driver as fatal.
    const res = gate(repoWith({ attributes: 'docs/AS_BUILT.md merge=as-built-log\n', shipsDriver: true }))
    expect(res.code).toBe(0)
  })
})

describe('the gate still fails everything it was built to fail', () => {
  test('MUTATION — the SAME attribute fails when the repo does NOT ship the driver', () => {
    // The pair for the test above, differing in one thing: the driver files. This is what keeps
    // the new allowance capability-gated instead of a blanket "custom drivers are fine".
    const res = gate(repoWith({ attributes: 'docs/AS_BUILT.md merge=as-built-log\n', shipsDriver: false }))
    expect(res.code).toBe(1)
    expect(res.out).toContain('does not ship it')
  })

  test('a DIFFERENT custom driver fails even when the entry-aware driver is shipped', () => {
    // Shipping one driver does not bless every name — otherwise the check degrades to "any custom
    // driver passes as long as this repo happens to contain a driver script".
    const res = gate(repoWith({ attributes: 'docs/AS_BUILT.md merge=frobnicate\n', shipsDriver: true }))
    expect(res.code).toBe(1)
  })

  test('no merge rule at all fails — the original purpose of the gate', () => {
    expect(gate(repoWith({ attributes: null })).code).toBe(1)
    expect(gate(repoWith({ attributes: '*.png binary\n' })).code).toBe(1)
  })

  test('a COMMENTED-OUT rule fails — a disabled guard reads exactly like a present one', () => {
    expect(gate(repoWith({ attributes: '# docs/AS_BUILT.md merge=union\n' })).code).toBe(1)
  })
})

describe('what is legitimately nothing to enforce', () => {
  test('a repo with no root SPEC.md is not governed and passes untouched', () => {
    expect(gate(repoWith({ attributes: null, governed: false })).code).toBe(0)
  })
})
