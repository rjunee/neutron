import { expect, test } from 'bun:test'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS_DIR = join(import.meta.dir, '..')

/**
 * The exact source of the fail-closed refusal, so a mutation targets the guard
 * itself rather than a paraphrase of it. A mutation test that silently stops
 * matching becomes a test that proves nothing while staying green — so the
 * `toContain` below is the control on the control.
 */
const GUARD = 'if (unexplained.length > 0) throw new Error(formatUnexplainedLedgerRows(unexplained, today))'

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

/**
 * MUTATION-PROVING THE ONE GUARD THAT DISTINGUISHES A FIX FROM A CATASTROPHE.
 *
 * Reconciling by identity instead of by ordinal makes the runner apply MORE than it
 * used to: a migration whose number was spent by something else now runs. A runner
 * that simply booted everything would satisfy every other scenario in this
 * directory — the live instance would come up, healthy instances would come up, a
 * fresh install would come up — and would silently accept a database carrying
 * schema changes no build describes. So the refusal has to be proven to be the
 * thing doing the refusing, not an accident of the fixture.
 *
 * The shape: run the SAME scenario against an unmutated copy (must pass — proves
 * the scenario is real and the harness resolves) and against a copy with the throw
 * removed (must fail — proves nothing else was refusing). Both copies are scratch
 * trees, so the checked-in runner is never edited.
 */
test('removing the unexplained-row refusal turns the fail-closed scenario red', async () => {
  const original = readFileSync(join(MIGRATIONS_DIR, 'runner.ts'), 'utf8')
  expect(original).toContain(GUARD)
  const root = join(MIGRATIONS_DIR, `.ordinal-mutant-${process.pid}-${Date.now()}`)
  const control = join(root, 'control')
  const mutant = join(root, 'mutant')
  const scenario = `
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyMigrations } from './runner.ts'
test('a recorded migration this build cannot explain throws', () => {
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
      // Every module `runner.ts` imports by relative path has to come along,
      // or the scratch copy fails to resolve and the "mutant went red" signal
      // becomes a module-resolution error that looks identical to a pass.
      cpSync(join(MIGRATIONS_DIR, 'db-path.ts'), join(dir, 'db-path.ts'))
      cpSync(join(MIGRATIONS_DIR, 'provenance.ts'), join(dir, 'provenance.ts'))
      cpSync(join(MIGRATIONS_DIR, 'git-index.ts'), join(dir, 'git-index.ts'))
      writeFileSync(join(dir, 'collision.test.ts'), scenario)
    }
    writeFileSync(join(control, 'runner.ts'), original)
    writeFileSync(join(mutant, 'runner.ts'), original.replace(GUARD, 'void formatUnexplainedLedgerRows'))
    const green = await runTest(control)
    expect(green.exitCode, green.output).toBe(0)
    const red = await runTest(mutant)
    expect(red.exitCode, red.output).not.toBe(0)
    expect(red.output).toContain('a recorded migration this build cannot explain throws')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)

/**
 * The other half: the NAME must be what decides "already applied".
 *
 * The renumbered file here carries an added comment, so its content hash differs
 * from the recorded one and the name is the only identity left. That is deliberate
 * and it is the realistic case — a merge that renumbers a migration is exactly when
 * its header comment gets touched. Without it the hash check answers first, the
 * mutant passes, and the test proves nothing (it did, on the first attempt).
 *
 * Disable the name check and the migration is applied a SECOND time, which its own
 * SQL refuses — the crash loop this change exists to end, reproduced deliberately.
 */
test('breaking identity reconciliation re-applies a renumbered migration', async () => {
  const original = readFileSync(join(MIGRATIONS_DIR, 'runner.ts'), 'utf8')
  const NAME_CHECK = "if (ledger.names.has(migration.name)) return 'recorded-by-name'"
  expect(original).toContain(NAME_CHECK)
  const root = join(MIGRATIONS_DIR, `.identity-mutant-${process.pid}-${Date.now()}`)
  const control = join(root, 'control')
  const mutant = join(root, 'mutant')
  const scenario = `
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyMigrations } from './runner.ts'
test('a migration that merged at another ordinal is not re-applied', () => {
  const before = join(import.meta.dir, 'before'); const after = join(import.meta.dir, 'after')
  mkdirSync(before); mkdirSync(after)
  writeFileSync(join(before, '0001_alpha.sql'), 'CREATE TABLE alpha (id INTEGER);')
  writeFileSync(join(after, '0002_alpha.sql'), '-- reflowed on merge\\nCREATE TABLE alpha (id INTEGER);')
  const db = new Database(':memory:')
  applyMigrations(db, before)
  expect(applyMigrations(db, after)).toEqual({ applied: [], skipped: [2] })
})
`
  try {
    for (const dir of [control, mutant]) {
      mkdirSync(dir, { recursive: true })
      cpSync(join(MIGRATIONS_DIR, 'db-path.ts'), join(dir, 'db-path.ts'))
      cpSync(join(MIGRATIONS_DIR, 'provenance.ts'), join(dir, 'provenance.ts'))
      cpSync(join(MIGRATIONS_DIR, 'git-index.ts'), join(dir, 'git-index.ts'))
      writeFileSync(join(dir, 'collision.test.ts'), scenario)
    }
    writeFileSync(join(control, 'runner.ts'), original)
    writeFileSync(
      join(mutant, 'runner.ts'),
      original.replace(NAME_CHECK, "if (false) return 'recorded-by-name'"),
    )
    const green = await runTest(control)
    expect(green.exitCode, green.output).toBe(0)
    const red = await runTest(mutant)
    expect(red.exitCode, red.output).not.toBe(0)
    expect(red.output).toContain('a migration that merged at another ordinal is not re-applied')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
