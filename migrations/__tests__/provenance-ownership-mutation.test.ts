/**
 * Kill evidence for the two guards that keep a wrong commit out of `_migrations`.
 *
 * A test asserting `toBeNull()` is a weak witness: null is also what a resolver
 * returns when it is broken, when the fixture is unreadable, or when the walk
 * never arrived. `migration-provenance.test.ts` pairs every such assertion with
 * a positive control, which rules out the accidents. This file rules out the
 * remaining one — that the guard is not what produced the null — by removing
 * each guard from a scratch copy of `provenance.ts` and proving the scenario
 * goes RED, then that the unmutated copy is GREEN on the same scenario.
 *
 * Two guards, two mutants, because they fail differently and only one of them
 * is a `.git` that belongs to a stranger:
 *
 *   ownership — the walk finds a `.git` in a repository that is not ours.
 *   anchoring — the walk sails past OUR root and adopts an ancestor's
 *               repository, which the name test waves through when both trees
 *               are named `neutron`.
 */

import { expect, test } from 'bun:test'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS_DIR = join(import.meta.dir, '..')

/** The two lines under test, quoted exactly so a refactor cannot silently no-op this file. */
const OWNERSHIP_LINE = "if (existsSync(join(dir, '.git'))) return isRoot ? gitDirAt(dir) : null"
const ANCHOR_LINE = 'if (isRoot) return null'

/**
 * Both scenarios in one scratch test file. `resolveDeployedCommit` is the whole
 * surface, so neither needs the runner or a database — which also keeps the
 * mutant copy down to `provenance.ts` and nothing else.
 */
const SCENARIO = `
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveDeployedCommit } from './provenance.ts'

const HOST_SHA = 'fedcba9876543210fedcba9876543210fedcba98'

function hostRepo(root: string, name: string): void {
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), HOST_SHA + '\\n')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name }))
}

test('ownership: a stranger\\'s repository is not our build', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'prov-own-'))
  try {
    hostRepo(tmp, 'someones-project')
    const nested = join(tmp, 'vendor', 'neutron', 'migrations')
    mkdirSync(nested, { recursive: true })
    expect(resolveDeployedCommit({}, nested)).toBeNull()
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('anchoring: a copy of this tree inside another checkout of it is not our build', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'prov-anchor-'))
  try {
    hostRepo(tmp, 'neutron')
    const copyRoot = join(tmp, 'vendor', 'neutron-copy')
    const copyMigrations = join(copyRoot, 'migrations')
    mkdirSync(copyMigrations, { recursive: true })
    writeFileSync(join(copyRoot, 'package.json'), JSON.stringify({ name: 'neutron' }))
    expect(resolveDeployedCommit({}, copyMigrations)).toBeNull()
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
`

async function runScenario(dir: string): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn(['bun', 'test', join(dir, 'ownership.test.ts')], {
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

test('removing either provenance guard turns the wrong-repository scenarios red', async () => {
  const original = readFileSync(join(MIGRATIONS_DIR, 'provenance.ts'), 'utf8')
  // If either line has been reworded, this file is asserting against a mutation
  // that no longer applies — the mutant would compile unchanged and "pass",
  // which is a false negative in the very check this file exists to be.
  expect(original).toContain(OWNERSHIP_LINE)
  expect(original).toContain(ANCHOR_LINE)

  const root = join(MIGRATIONS_DIR, `.provenance-mutant-${process.pid}-${Date.now()}`)
  const control = join(root, 'control')
  const noOwnership = join(root, 'no-ownership')
  const noAnchor = join(root, 'no-anchor')

  try {
    for (const dir of [control, noOwnership, noAnchor]) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'ownership.test.ts'), SCENARIO)
    }
    cpSync(join(MIGRATIONS_DIR, 'provenance.ts'), join(control, 'provenance.ts'))
    // Ownership dropped: any `.git` is accepted, whoever it belongs to.
    writeFileSync(
      join(noOwnership, 'provenance.ts'),
      original.replace(OWNERSHIP_LINE, "if (existsSync(join(dir, '.git'))) return gitDirAt(dir)"),
    )
    // Anchoring dropped: our own root no longer ends the walk, so it keeps
    // climbing into whatever repository encloses us.
    writeFileSync(join(noAnchor, 'provenance.ts'), original.replace(ANCHOR_LINE, ''))

    const green = await runScenario(control)
    expect(green.exitCode, green.output).toBe(0)

    const ownershipRed = await runScenario(noOwnership)
    expect(ownershipRed.exitCode, ownershipRed.output).not.toBe(0)
    expect(ownershipRed.output).toContain("stranger's repository is not our build")

    const anchorRed = await runScenario(noAnchor)
    expect(anchorRed.exitCode, anchorRed.output).not.toBe(0)
    expect(anchorRed.output).toContain('another checkout of it is not our build')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
