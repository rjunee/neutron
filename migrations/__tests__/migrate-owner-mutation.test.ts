import { expect, test } from 'bun:test'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS_DIR = join(import.meta.dir, '..')
const BODY = 'export function migrateOwnerMismatch(recorded: string, here: string): boolean {\n  return canonicalOwnerPath(recorded) !== canonicalOwnerPath(here)\n}'

async function runTest(dir: string): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn(['bun', 'test', join(dir, 'owner-refusal.test.ts')], {
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

test('disabling the ownership comparison turns the foreign-owner refusal red', async () => {
  const original = readFileSync(join(MIGRATIONS_DIR, 'runner.ts'), 'utf8')
  expect(original).toContain(BODY)
  const root = join(MIGRATIONS_DIR, `.migrate-owner-mutant-${process.pid}-${Date.now()}`)
  const control = join(root, 'control')
  const mutant = join(root, 'mutant')
  const scenario = `
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyMigrations } from './runner.ts'

test('a marker owned by a foreign checkout is refused', () => {
  const home = join(import.meta.dir, 'home')
  mkdirSync(home)
  writeFileSync(join(home, '.migrate-owner'), '/nonexistent-deploy-checkout/migrations\\n')
  writeFileSync(join(import.meta.dir, '0001_base.sql'), 'CREATE TABLE base (id INTEGER);')
  const db = new Database(join(home, 'project.db'), { create: true })
  expect(() => applyMigrations(db, import.meta.dir)).toThrow()
})
`
  try {
    for (const dir of [control, mutant]) {
      mkdirSync(dir, { recursive: true })
      cpSync(join(MIGRATIONS_DIR, 'db-path.ts'), join(dir, 'db-path.ts'))
      cpSync(join(MIGRATIONS_DIR, 'provenance.ts'), join(dir, 'provenance.ts'))
      cpSync(join(MIGRATIONS_DIR, 'git-index.ts'), join(dir, 'git-index.ts'))
      writeFileSync(join(dir, 'owner-refusal.test.ts'), scenario)
    }
    writeFileSync(join(control, 'runner.ts'), original)
    writeFileSync(
      join(mutant, 'runner.ts'),
      original.replace(
        'return canonicalOwnerPath(recorded) !== canonicalOwnerPath(here)',
        'return false',
      ),
    )
    const green = await runTest(control)
    expect(green.exitCode, green.output).toBe(0)
    const red = await runTest(mutant)
    expect(red.exitCode, red.output).not.toBe(0)
    expect(red.output).toContain('a marker owned by a foreign checkout is refused')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
