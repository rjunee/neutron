/**
 * Composition-field ratchet guard self-test.
 *
 * The coverage gate (`open/__tests__/composition-field-coverage.test.ts`) reads
 * its own baseline, so the edit it cannot see is the one that moves a field from
 * `WIRED_FIELDS` into `UNWIRED_FIELDS`: the assertion that the product sets it
 * simply stops existing, the consumer takes its `undefined` branch, the
 * capability goes dark, and CI stays green.
 * `composition-field-ratchet-guard.sh` is the guard for that, and this file pins
 * its boundary in BOTH directions — because a guard that only ever passes is
 * indistinguishable from one that is dead, which is the failure mode this repo
 * has already shipped (#388: a gate failing on its own documentation, unnoticed
 * behind another standing red).
 *
 * Cases pinned: equal → pass, promoted → pass, field DELETED → pass (a real
 * deletion must not be a false alarm), demoted → FAIL naming the field, and an
 * unreadable declaration set → exit 2 rather than a vacuous pass.
 */
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { compareCompositionFieldInventories } from './composition-field-ratchet-compare.ts'

const COMPARE_TS = fileURLToPath(
  new URL('./composition-field-ratchet-compare.ts', import.meta.url),
)
const GUARD_SH = fileURLToPath(new URL('./composition-field-ratchet-guard.sh', import.meta.url))

const DECLARED = ['push_dispatcher', 'work_board', 'trident', 'http_handler']

describe('composition-field ratchet comparator (pure)', () => {
  test('identical inventories → ok', () => {
    const inv = { wired: ['push_dispatcher', 'work_board'], unwired: ['http_handler'] }
    const r = compareCompositionFieldInventories(inv, inv, DECLARED)
    expect(r.ok).toBe(true)
    expect(r.demoted).toEqual([])
  })

  test('a field PROMOTED into the wired set → ok, and reported', () => {
    const r = compareCompositionFieldInventories(
      { wired: ['push_dispatcher'], unwired: ['work_board'] },
      { wired: ['push_dispatcher', 'work_board'], unwired: [] },
      DECLARED,
    )
    expect(r.ok).toBe(true)
    expect(r.promoted).toEqual(['work_board'])
  })

  test('a field DEMOTED into the allowlist → FAIL, names it', () => {
    // The exact defeat this guard exists for: the coverage test would go green
    // because its own baseline no longer mentions the field.
    const r = compareCompositionFieldInventories(
      { wired: ['push_dispatcher', 'work_board'], unwired: [] },
      { wired: ['push_dispatcher'], unwired: ['work_board'] },
      DECLARED,
    )
    expect(r.ok).toBe(false)
    expect(r.demoted).toEqual(['work_board'])
  })

  test('a field dropped from BOTH lists is still a demotion while it is declared', () => {
    // Silently deleting the entry is the same defeat with fewer keystrokes.
    const r = compareCompositionFieldInventories(
      { wired: ['push_dispatcher', 'work_board'], unwired: [] },
      { wired: ['push_dispatcher'], unwired: [] },
      DECLARED,
    )
    expect(r.ok).toBe(false)
    expect(r.demoted).toEqual(['work_board'])
  })

  test('DELETING the field itself → ok (not a false alarm)', () => {
    // Removing a capability from the product is a legitimate change. A guard
    // that reds on it would be worked around rather than believed.
    const r = compareCompositionFieldInventories(
      { wired: ['push_dispatcher', 'work_board'], unwired: [] },
      { wired: ['push_dispatcher'], unwired: [] },
      ['push_dispatcher', 'trident', 'http_handler'],
    )
    expect(r.ok).toBe(true)
    expect(r.deleted).toEqual(['work_board'])
  })
})

/** Write a minimal, import-free inventory module. */
function writeInventory(path: string, wired: string[], unwired: string[]): void {
  writeFileSync(
    path,
    `export const WIRED_FIELDS = [${wired
      .map((f) => `{ field: '${f}', provides: 'x' }`)
      .join(',')}]\n` +
      `export const UNWIRED_FIELDS = [${unwired
        .map((f) => `{ field: '${f}', why: 'x', costs: 'x' }`)
        .join(',')}]\n` +
      `export const MIN_EXPECTED_WIRED_FIELDS = 1\n`,
  )
}

/**
 * Write a stand-in for the declaration reader.
 *
 * The comparator imports `<root>/open/__tests__/declared-composition-fields.ts`
 * and calls `readDeclaredCompositionFields(root)`, so a throwaway repo needs one
 * — the same way the route-slot guard's fixture repo carries a stand-in
 * `ROUTE_SLOTS`. The REAL reader is proven separately, and far more thoroughly,
 * by `open/__tests__/declared-composition-fields.test.ts`.
 */
function writeReader(path: string, fields: string[] | null): void {
  writeFileSync(
    path,
    fields === null
      ? `export function readDeclaredCompositionFields() {\n` +
          `  throw new Error('read only 3 CompositionInput fields, below the floor of 60')\n` +
          `}\n`
      : `export function readDeclaredCompositionFields() {\n` +
          `  return [${fields.map((f) => `{ name: '${f}' }`).join(',')}]\n` +
          `}\n`,
  )
}

function run(cmd: string, args: string[], cwd?: string): { code: number; out: string } {
  try {
    const out = execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(cwd === undefined ? {} : { cwd }),
    })
    return { code: 0, out }
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

/** Lay out a fixture repo root with the paths the comparator resolves. */
function fixtureRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  mkdirSync(join(dir, 'open', '__tests__'), { recursive: true })
  return dir
}

describe('composition-field ratchet comparator CLI', () => {
  test('equal → exit 0; demoted → exit 1 naming the field', () => {
    const dir = fixtureRoot('composition-field-ratchet-cli-')
    try {
      const mainF = join(dir, 'main-inventory.ts')
      const okF = join(dir, 'ok-inventory.ts')
      const badF = join(dir, 'bad-inventory.ts')
      writeInventory(mainF, ['push_dispatcher', 'work_board'], [])
      writeInventory(okF, ['push_dispatcher', 'work_board'], [])
      writeInventory(badF, ['push_dispatcher'], ['work_board'])
      writeReader(
        join(dir, 'open', '__tests__', 'declared-composition-fields.ts'),
        ['push_dispatcher', 'work_board'],
      )

      const ok = run('bun', [COMPARE_TS, mainF, okF, dir])
      expect(ok.code).toBe(0)
      expect(ok.out).toContain('COMPOSITION-FIELD RATCHET: OK')

      const bad = run('bun', [COMPARE_TS, mainF, badF, dir])
      expect(bad.code).toBe(1)
      expect(bad.out).toContain('COMPOSITION-FIELD RATCHET: FAIL')
      expect(bad.out).toContain('work_board')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  test('an unreadable declaration set is refused (exit 2), never a silent pass', () => {
    // If the reader cannot enumerate the fields, EVERY demoted field would look
    // like a legitimate deletion and the guard would pass while the baseline
    // shrank. The reader throws in that case; the comparator must propagate it.
    const dir = fixtureRoot('composition-field-ratchet-empty-')
    try {
      const mainF = join(dir, 'main-inventory.ts')
      const headF = join(dir, 'head-inventory.ts')
      writeInventory(mainF, ['push_dispatcher'], [])
      writeInventory(headF, [], ['push_dispatcher'])
      writeReader(join(dir, 'open', '__tests__', 'declared-composition-fields.ts'), null)
      const r = run('bun', [COMPARE_TS, mainF, headF, dir])
      expect(r.code).toBe(2)
      expect(r.out).toContain('below the floor')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

describe('composition-field ratchet guard (shell, against a throwaway git repo)', () => {
  test('the git plumbing catches a demotion on a branch, and skips on main', () => {
    const dir = fixtureRoot('composition-field-ratchet-git-')
    try {
      const invRel = 'open/__tests__/composition-field-coverage-inventory.ts'
      const readerRel = 'open/__tests__/declared-composition-fields.ts'
      writeInventory(join(dir, invRel), ['push_dispatcher', 'work_board'], [])
      writeReader(join(dir, readerRel), ['push_dispatcher', 'work_board'])

      git(dir, 'init', '-q', '-b', 'main')
      git(dir, 'config', 'user.email', 'ci@example.com')
      git(dir, 'config', 'user.name', 'ci')
      git(dir, 'add', '-A')
      git(dir, 'commit', '-q', '-m', 'baseline')

      const env = {
        COMPOSITION_FIELD_RATCHET_ROOT: dir,
        COMPOSITION_FIELD_RATCHET_MAIN_REF: 'main',
      }
      const runGuard = (): { code: number; out: string } => {
        try {
          const out = execFileSync('bash', [GUARD_SH], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, ...env },
          })
          return { code: 0, out }
        } catch (e: unknown) {
          const err = e as { status?: number; stdout?: string; stderr?: string }
          return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
        }
      }

      // HEAD == main → the ratchet is N/A and must skip rather than judge.
      const onMain = runGuard()
      expect(onMain.code).toBe(0)
      expect(onMain.out).toContain('push-to-main')

      // Branch off and demote a field into the allowlist.
      git(dir, 'checkout', '-q', '-b', 'demote')
      writeInventory(join(dir, invRel), ['push_dispatcher'], ['work_board'])
      git(dir, 'add', '-A')
      git(dir, 'commit', '-q', '-m', 'demote work_board')

      const demoted = runGuard()
      expect(demoted.code).toBe(1)
      expect(demoted.out).toContain('work_board')

      // The temp copy of main's inventory must not survive the run — a stray .ts
      // in the tree would be picked up by typecheck on the next job.
      const leftovers = run('bash', [
        '-c',
        `ls -A "${dir}" | grep composition-field-inventory-main || true`,
      ])
      expect(leftovers.out.trim()).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    // Generous: each assertion spawns `bun` or `git`, and the cost of being wrong
    // here is a flaky red on a contended runner — which is how a gate stops being
    // believed. Bounded all the same, so a wedge reports rather than hangs.
  }, 60_000)
})
