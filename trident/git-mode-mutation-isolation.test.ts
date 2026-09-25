import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')

test('git-mode mutation subprocess preserves another mutant report during setup and cleanup', () => {
  const parent = join(root, '.trident-mutants')
  mkdirSync(parent, { recursive: true })
  const sibling = mkdtempSync(join(parent, 'isolation-sibling-'))
  const report = join(sibling, 'report.xml')
  try {
    writeFileSync(report, '<report>owned by another test</report>')
    const child = Bun.spawnSync([process.execPath, 'test', 'trident/git-mode-mutation.test.ts'], {
      cwd: root, stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
    })
    const output = child.stdout.toString() + child.stderr.toString()
    expect(child.exitCode, output).toBe(0)
    expect(output).toContain('POSITIVE CONTROL — the UNMUTATED copy is green')
    expect(output).toContain('CAUGHT: a transport failure is classified as a rejected credential')
    expect(output).toContain('0 fail')
    expect(readFileSync(report, 'utf8')).toBe('<report>owned by another test</report>')
  } finally {
    rmSync(sibling, { recursive: true, force: true })
  }
}, 40_000)
