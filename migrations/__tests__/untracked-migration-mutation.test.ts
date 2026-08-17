/**
 * Kill evidence for the two halves of the untracked-migration guard.
 *
 * The assertions in `untracked-migration.test.ts` are paired with controls, which
 * rules out most ways of being vacuous. This file rules out the last one — that
 * the guard is not what produced the behaviour — by deleting each half from a
 * scratch copy and proving the matching scenario goes RED, with the unmutated
 * copy GREEN on both.
 *
 * TWO GUARDS, TWO MUTANTS, and they pull in opposite directions, which is the
 * point. One makes the runner refuse a file the tree does not track. The other
 * stops it refusing when the DIRECTORY is not tracked either — a migration tree
 * copied into `node_modules/`, staged in a build directory, unpacked beside a
 * checkout. Remove the first and a stray migration is silently applied again.
 * Remove the second and every install of that shape refuses to boot. Neither
 * mutant kills the other's scenario, so they are shown to be doing different
 * work rather than one masking the other.
 */

import { expect, test } from 'bun:test'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS_DIR = join(import.meta.dir, '..')
const FIXTURE = join(import.meta.dir, 'git-index-fixture.ts')

/** The two lines under test, quoted exactly so a reword cannot silently no-op this file. */
const REFUSAL_LINE = 'throw new Error(formatUntrackedMigration(m, tree, deployedCommit))'
const EMPTY_DIRECTORY_LINE = "if (tracked.size === 0) return unverifiable('directory-not-tracked')"

/** Every module `runner.ts` reaches by relative path, or the copy cannot resolve. */
const COPIED = ['db-path.ts', 'provenance.ts', 'git-index.ts']

const SCENARIO = `
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from './runner.ts'
import { encodeIndex } from ${JSON.stringify(FIXTURE)}

/** A checkout whose index tracks exactly \`tracked\`, holding one migration file. */
function checkout(tmp: string, tracked: string[]): string {
  const root = join(tmp, 'tree')
  const dir = join(root, 'migrations')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'neutron' }))
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\\n')
  writeFileSync(
    join(root, '.git', 'index'),
    encodeIndex([{ path: 'package.json' }, ...tracked.map((f) => ({ path: 'migrations/' + f }))]),
  )
  writeFileSync(join(dir, '0001_alpha.sql'), 'CREATE TABLE alpha (id INTEGER);')
  return dir
}

function inTmp(name: string, body: (tmp: string) => void): void {
  const tmp = mkdtempSync(join(tmpdir(), name))
  try {
    body(tmp)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

test('refusal: an untracked migration in a tracked directory is not applied', () => {
  inTmp('untracked-mutant-', (tmp) => {
    // The directory is part of the tree (a tracked sibling); this file is not.
    const dir = checkout(tmp, ['README.md'])
    expect(() => applyMigrations(new Database(':memory:'), dir)).toThrow(/0001_alpha\\.sql/)
  })
})

test('reach: a migration directory the tree does not track at all still boots', () => {
  inTmp('unverifiable-mutant-', (tmp) => {
    const dir = checkout(tmp, [])
    expect(applyMigrations(new Database(':memory:'), dir)).toEqual({ applied: [1], skipped: [] })
  })
})
`

async function runScenario(dir: string): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn(['bun', 'test', join(dir, 'untracked.test.ts')], {
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

test('removing either half of the untracked guard turns its own scenario red', async () => {
  const runner = readFileSync(join(MIGRATIONS_DIR, 'runner.ts'), 'utf8')
  const provenance = readFileSync(join(MIGRATIONS_DIR, 'provenance.ts'), 'utf8')
  // If either line has been reworded, this file is asserting against a mutation
  // that no longer applies — the mutant would compile unchanged and "pass",
  // which is a false negative in the very check this file exists to be.
  expect(runner).toContain(REFUSAL_LINE)
  expect(provenance).toContain(EMPTY_DIRECTORY_LINE)

  const root = join(MIGRATIONS_DIR, `.untracked-mutant-${process.pid}-${Date.now()}`)
  const control = join(root, 'control')
  const noRefusal = join(root, 'no-refusal')
  const noReach = join(root, 'no-reach')

  try {
    for (const dir of [control, noRefusal, noReach]) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'untracked.test.ts'), SCENARIO)
      writeFileSync(join(dir, 'runner.ts'), runner)
      for (const file of COPIED) cpSync(join(MIGRATIONS_DIR, file), join(dir, file))
    }
    // Refusal dropped: an untracked file is applied and recorded, as before.
    writeFileSync(join(noRefusal, 'runner.ts'), runner.replace(REFUSAL_LINE, 'continue'))
    // Reach dropped: a directory the tree does not track reads as a tree that
    // tracks nothing, so every migration in it is refused.
    writeFileSync(join(noReach, 'provenance.ts'), provenance.replace(EMPTY_DIRECTORY_LINE, ''))

    const green = await runScenario(control)
    expect(green.exitCode, green.output).toBe(0)

    const refusalRed = await runScenario(noRefusal)
    expect(refusalRed.exitCode, refusalRed.output).not.toBe(0)
    expect(refusalRed.output).toContain('an untracked migration in a tracked directory is not applied')
    // EXACTLY ONE of the two scenarios died, and it is the named one — which is
    // what makes the guards distinguishable rather than one standing in for the
    // other. (Asserted on the count rather than on the absence of the other
    // name, because a passing test's name is not printed at all.)
    expect(refusalRed.output, refusalRed.output).toContain('1 pass')
    expect(refusalRed.output, refusalRed.output).toContain('1 fail')

    const reachRed = await runScenario(noReach)
    expect(reachRed.exitCode, reachRed.output).not.toBe(0)
    expect(reachRed.output).toContain('does not track at all still boots')
    expect(reachRed.output, reachRed.output).toContain('1 pass')
    expect(reachRed.output, reachRed.output).toContain('1 fail')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
