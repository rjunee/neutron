import { expect, test } from 'bun:test'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS_DIR = join(import.meta.dir, '..')
const BODY = 'export function migrationNameMismatch(recorded: string, file: string): boolean {\n  return recorded !== file\n}'

async function runTest(dir: string): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn(['bun', 'test', join(dir, 'collision.test.ts')], {
    cwd: join(MIGRATIONS_DIR, '..'),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { exitCode, output: `${stdout}\n${stderr}` }
}

test('disabling the migration-name comparison turns the collision guard red', async () => {
  const original = readFileSync(join(MIGRATIONS_DIR, 'runner.ts'), 'utf8')
  expect(original).toContain(BODY)
  const root = join(MIGRATIONS_DIR, `.ordinal-mutant-${process.pid}-${Date.now()}`)
  const control = join(root, 'control')
  const mutant = join(root, 'mutant')
  const scenario = `
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyMigrations } from './runner.ts'
test('mismatched migration name throws', () => {
  const a = join(import.meta.dir, 'a'); const b = join(import.meta.dir, 'b')
  mkdirSync(a); mkdirSync(b)
  writeFileSync(join(a, '0001_alpha.sql'), 'CREATE TABLE alpha (id INTEGER);')
  writeFileSync(join(b, '0001_beta.sql'), 'CREATE TABLE beta (id INTEGER);')
  const db = new Database(':memory:')
  applyMigrations(db, a)
  expect(() => applyMigrations(db, b)).toThrow()
})
`
  try {
    for (const dir of [control, mutant]) {
      mkdirSync(dir, { recursive: true })
      cpSync(join(MIGRATIONS_DIR, 'db-path.ts'), join(dir, 'db-path.ts'))
      writeFileSync(join(dir, 'collision.test.ts'), scenario)
    }
    writeFileSync(join(control, 'runner.ts'), original)
    writeFileSync(join(mutant, 'runner.ts'), original.replace('return recorded !== file', 'return false'))
    const green = await runTest(control)
    expect(green.exitCode, green.output).toBe(0)
    const red = await runTest(mutant)
    expect(red.exitCode, red.output).not.toBe(0)
    expect(red.output).toContain('mismatched migration name throws')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
