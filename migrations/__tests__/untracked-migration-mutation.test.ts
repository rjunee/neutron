/**
 * Kill evidence for each property of the untracked-migration guard.
 *
 * The assertions in `untracked-migration.test.ts` are paired with controls, which
 * rules out most ways of being vacuous. This file rules out the last one — that
 * the guard is not what produced the behaviour — by deleting each property from a
 * scratch copy and proving the matching scenario goes RED, with the unmutated
 * copy GREEN on all of them.
 *
 * FOUR PROPERTIES, FOUR MUTANTS, and they pull in different directions, which is
 * the point:
 *
 *   REFUSAL       makes the runner refuse a file the tree does not track. Remove
 *                 it and a stray migration is silently applied again.
 *   REACH         stops it refusing when the DIRECTORY is not tracked either — a
 *                 migration tree copied into `node_modules/`, staged in a build
 *                 directory, unpacked beside a checkout. Remove it and every
 *                 install of that shape refuses to boot.
 *   RECORDING     writes `unverifiable:<reason>` when membership could not be
 *                 established. Remove it and the ledger claims a verification
 *                 that never happened — which is the same forensic dead end the
 *                 provenance columns exist to close, now wearing a clean answer.
 *   CONTEXT       names the ledger row that shares the ordinal, inside the same
 *                 refusal. Remove it and an operator staring at an occupied ordinal
 *                 and a bare "not tracked" goes hunting a second problem that is
 *                 not there — the presentation the last outage arrived in.
 *
 * EACH MUTANT MUST KILL A DECLARED NUMBER OF SCENARIOS, and the number is part of
 * the evidence rather than a uniform 1. CONTEXT is NESTED INSIDE REFUSAL: the
 * context line is only observable through the refusal that prints it, so deleting
 * the refusal necessarily kills the context scenario too. Declaring `deaths: 2`
 * there and `deaths: 1` for CONTEXT is what still distinguishes them — CONTEXT
 * killing exactly its own scenario proves that line does independent work, and
 * REFUSAL killing both proves the nesting rather than hiding it. (This used to be a
 * flat "exactly one" because the runner had two separate throw sites for the two
 * cases; identity reconciliation collapsed them, since an occupied ordinal is no
 * longer a finding of its own.) Asserted on pass/fail counts, because a passing
 * test's name is never printed.
 */

import { expect, test } from 'bun:test'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS_DIR = join(import.meta.dir, '..')
const FIXTURE = join(import.meta.dir, 'git-index-fixture.ts')

/** Every module `runner.ts` reaches by relative path, or the copy cannot resolve. */
const COPIED = ['db-path.ts', 'provenance.ts', 'git-index.ts']

interface Mutant {
  /** What is being deleted. */
  readonly property: string
  /** Which copied file to mutate. */
  readonly file: 'runner.ts' | 'provenance.ts'
  /**
   * The source text to replace, quoted EXACTLY. Asserted present in the
   * unmutated file first: if it has been reworded, this file would be asserting
   * against a mutation that no longer applies — the mutant would compile
   * unchanged and "pass", a false negative in the very check this file is.
   */
  readonly find: string
  /** What to replace it with — the pre-guard behaviour. */
  readonly replace: string
  /** A distinctive fragment of a scenario name that must go red. */
  readonly kills: string
  /** How many scenarios this deletion must kill. See the header on nesting. */
  readonly deaths: number
}

const MUTANTS: readonly Mutant[] = [
  {
    property: 'REFUSAL',
    file: 'runner.ts',
    find: 'if (untracked !== null) {',
    replace: 'if (false) {',
    kills: 'an untracked migration in a tracked directory is not applied',
    deaths: 2,
  },
  {
    property: 'REACH',
    file: 'provenance.ts',
    find: "if (tracked.size === 0) return unverifiable('directory-not-tracked')",
    replace: '',
    kills: 'does not track at all still boots',
    deaths: 1,
  },
  {
    property: 'RECORDING',
    file: 'runner.ts',
    find: 'unverifiedTreeProvenance(tree.reason)',
    replace: 'TRACKED_IN_DEPLOYED_TREE',
    kills: 'records that provenance was unverifiable',
    deaths: 1,
  },
  {
    property: 'CONTEXT',
    file: 'runner.ts',
    find: 'ledger.byVersion.get(migration.version) ?? null',
    replace: 'null',
    kills: 'names the row sharing its ordinal',
    deaths: 1,
  },
]

const SCENARIO = `
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from './runner.ts'
import { encodeIndex } from ${JSON.stringify(FIXTURE)}

const ALPHA = 'CREATE TABLE alpha (id INTEGER);'
const BETA = 'CREATE TABLE beta (id INTEGER);'

/** A checkout whose index tracks exactly \`tracked\`, holding the given files. */
function checkout(tmp: string, name: string, tracked: string[], files: Record<string, string>): string {
  const root = join(tmp, name)
  const dir = join(root, 'migrations')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'neutron' }))
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\\n')
  writeFileSync(
    join(root, '.git', 'index'),
    encodeIndex([{ path: 'package.json' }, ...tracked.map((f) => ({ path: 'migrations/' + f }))]),
  )
  for (const [file, sql] of Object.entries(files)) writeFileSync(join(dir, file), sql)
  return dir
}

/** A migration tree with no git metadata anywhere above it. */
function bareTree(tmp: string, name: string, files: Record<string, string>): string {
  const dir = join(tmp, name, 'migrations')
  mkdirSync(dir, { recursive: true })
  for (const [file, sql] of Object.entries(files)) writeFileSync(join(dir, file), sql)
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
    const dir = checkout(tmp, 'tree', ['README.md'], { '0001_alpha.sql': ALPHA })
    expect(() => applyMigrations(new Database(':memory:'), dir)).toThrow(/0001_alpha\\.sql/)
  })
})

test('reach: a migration directory the tree does not track at all still boots', () => {
  inTmp('unverifiable-mutant-', (tmp) => {
    const dir = checkout(tmp, 'tree', [], { '0001_alpha.sql': ALPHA })
    expect(applyMigrations(new Database(':memory:'), dir)).toEqual({ applied: [1], skipped: [] })
  })
})

test('recording: a tree with no git metadata records that provenance was unverifiable', () => {
  inTmp('recording-mutant-', (tmp) => {
    const db = new Database(':memory:')
    const dir = bareTree(tmp, 'bare', { '0001_alpha.sql': ALPHA })
    expect(applyMigrations(db, dir)).toEqual({ applied: [1], skipped: [] })
    expect(db.query('SELECT tree_provenance AS p FROM _migrations').get()).toEqual({
      p: 'unverifiable:no-git-metadata',
    })
  })
})

test('context: an untracked file at a recorded ordinal names the row sharing its ordinal', () => {
  inTmp('context-mutant-', (tmp) => {
    const db = new Database(':memory:')
    applyMigrations(db, checkout(tmp, 'was', ['0001_alpha.sql'], { '0001_alpha.sql': ALPHA }))
    // Ordinal 1 is recorded as \`alpha\`; on disk it is \`beta\`, and untracked.
    const now = checkout(tmp, 'now', ['README.md'], { '0001_beta.sql': BETA })
    let message = ''
    try {
      applyMigrations(db, now)
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain('NOT part of the deployed tree')
    expect(message).toContain('Ordinal 1 is ALREADY recorded, under the name "alpha"')
    // The remedy is deletion. A repairs.json entry here would acknowledge a row
    // against a file this tree does not track, which is the disease.
    expect(message).not.toContain('"recorded_name"')
  })
})
`

/** How many scenarios the file above declares — one dies per mutant. */
const SCENARIO_COUNT = 4

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

test('removing any one property of the untracked guard turns its own scenario red', async () => {
  const sources: Record<string, string> = {
    'runner.ts': readFileSync(join(MIGRATIONS_DIR, 'runner.ts'), 'utf8'),
    'provenance.ts': readFileSync(join(MIGRATIONS_DIR, 'provenance.ts'), 'utf8'),
  }
  for (const mutant of MUTANTS) {
    // A reworded target would make this whole file inert — see `Mutant.find`.
    expect(sources[mutant.file], mutant.property).toContain(mutant.find)
  }

  const root = join(MIGRATIONS_DIR, `.untracked-mutant-${process.pid}-${Date.now()}`)

  /** A scratch copy of the module tree plus the scenario file. */
  function plant(name: string): string {
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'untracked.test.ts'), SCENARIO)
    writeFileSync(join(dir, 'runner.ts'), sources['runner.ts'] ?? '')
    for (const file of COPIED) cpSync(join(MIGRATIONS_DIR, file), join(dir, file))
    return dir
  }

  try {
    // THE CONTROL. Every scenario passes against the unmutated modules, so each
    // red below is the deletion and not a scenario that never worked.
    const green = await runScenario(plant('control'))
    expect(green.exitCode, green.output).toBe(0)
    expect(green.output, green.output).toContain(`${SCENARIO_COUNT} pass`)

    for (const mutant of MUTANTS) {
      const dir = plant(`no-${mutant.property.toLowerCase()}`)
      const mutated = (sources[mutant.file] ?? '').replace(mutant.find, mutant.replace)
      writeFileSync(join(dir, mutant.file), mutated)

      const red = await runScenario(dir)
      expect(red.exitCode, `${mutant.property}\n${red.output}`).not.toBe(0)
      expect(red.output, `${mutant.property}\n${red.output}`).toContain(mutant.kills)
      // The DECLARED number of scenarios died, and one of them is the named one —
      // which is what keeps the properties distinguishable rather than one standing
      // in for another. See the header for why the number is not uniformly 1.
      expect(red.output, `${mutant.property}\n${red.output}`).toContain(
        `${SCENARIO_COUNT - mutant.deaths} pass`,
      )
      expect(red.output, `${mutant.property}\n${red.output}`).toContain(`${mutant.deaths} fail`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 180_000)
