/**
 * Route-slot ratchet guard self-test.
 *
 * The coverage gate (`open/__tests__/route-slot-coverage.test.ts`) reads its own
 * baseline, so the edit it cannot see is the one that moves a rung from
 * `MOUNTED_SLOTS` into `UNMOUNTED_SLOTS`: the assertion that the route is
 * reachable simply stops existing, the path starts 404ing, and CI stays green.
 * `route-slot-ratchet-guard.sh` is the guard for that, and this file pins its
 * boundary in BOTH directions — because a guard that only ever passes is
 * indistinguishable from one that is dead, which is the failure mode this repo
 * has already shipped (#388: a gate failing on its own documentation, unnoticed
 * behind another standing red).
 *
 * Cases pinned: equal → pass, promoted → pass, slot DELETED → pass (a real
 * deletion must not be a false alarm), demoted → FAIL naming the rung.
 */
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { compareRouteSlotInventories } from './route-slot-ratchet-compare.ts'

const COMPARE_TS = fileURLToPath(new URL('./route-slot-ratchet-compare.ts', import.meta.url))
const GUARD_SH = fileURLToPath(new URL('./route-slot-ratchet-guard.sh', import.meta.url))

const DECLARED = ['app-tasks', 'app-docs', 'app-reminders', 'cores']

describe('route-slot ratchet comparator (pure)', () => {
  test('identical inventories → ok', () => {
    const inv = { mounted: ['app-tasks', 'app-docs'], unmounted: ['app-reminders'] }
    const r = compareRouteSlotInventories(inv, inv, DECLARED)
    expect(r.ok).toBe(true)
    expect(r.demoted).toEqual([])
  })

  test('a rung PROMOTED into the served set → ok, and reported', () => {
    const r = compareRouteSlotInventories(
      { mounted: ['app-tasks'], unmounted: ['app-docs'] },
      { mounted: ['app-tasks', 'app-docs'], unmounted: [] },
      DECLARED,
    )
    expect(r.ok).toBe(true)
    expect(r.promoted).toEqual(['app-docs'])
  })

  test('a rung DEMOTED into the allowlist → FAIL, names it', () => {
    // The exact defeat this guard exists for: the coverage test would go green
    // because its own baseline no longer mentions the rung.
    const r = compareRouteSlotInventories(
      { mounted: ['app-tasks', 'app-docs'], unmounted: [] },
      { mounted: ['app-tasks'], unmounted: ['app-docs'] },
      DECLARED,
    )
    expect(r.ok).toBe(false)
    expect(r.demoted).toEqual(['app-docs'])
  })

  test('a rung dropped from BOTH lists is still a demotion while the slot exists', () => {
    // Silently deleting the entry is the same defeat with fewer keystrokes.
    const r = compareRouteSlotInventories(
      { mounted: ['app-tasks', 'app-docs'], unmounted: [] },
      { mounted: ['app-tasks'], unmounted: [] },
      DECLARED,
    )
    expect(r.ok).toBe(false)
    expect(r.demoted).toEqual(['app-docs'])
  })

  test('DELETING the slot itself → ok (not a false alarm)', () => {
    // Removing a surface from the product is a legitimate change. A guard that
    // reds on it would be worked around rather than believed.
    const r = compareRouteSlotInventories(
      { mounted: ['app-tasks', 'app-docs'], unmounted: [] },
      { mounted: ['app-tasks'], unmounted: [] },
      ['app-tasks', 'app-reminders', 'cores'],
    )
    expect(r.ok).toBe(true)
    expect(r.deleted).toEqual(['app-docs'])
  })
})

/** Write a minimal, import-free inventory module. */
function writeInventory(path: string, mounted: string[], unmounted: string[]): void {
  const entry = (r: string): string =>
    `{ rung: '${r}', composition: '${r.replace(/-/g, '_')}_surface', serves: 'x', why: 'x' }`
  writeFileSync(
    path,
    `export const MOUNTED_SLOTS = [${mounted.map(entry).join(',')}]\n` +
      `export const UNMOUNTED_SLOTS = [${unmounted.map(entry).join(',')}]\n` +
      `export const MIN_EXPECTED_MOUNTED_SLOTS = 1\n`,
  )
}

/** Write a minimal ROUTE_SLOTS registry stand-in. */
function writeSlots(path: string, rungs: string[]): void {
  writeFileSync(
    path,
    `export const ROUTE_SLOTS = [${rungs
      .map((r) => `{ rung: '${r}', composition: '${r}' }`)
      .join(',')}]\n`,
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

describe('route-slot ratchet comparator CLI', () => {
  test('equal → exit 0; demoted → exit 1 naming the rung', () => {
    const dir = mkdtempSync(join(tmpdir(), 'route-slot-ratchet-cli-'))
    try {
      const mainF = join(dir, 'main-inventory.ts')
      const okF = join(dir, 'ok-inventory.ts')
      const badF = join(dir, 'bad-inventory.ts')
      const slotsF = join(dir, 'slots.ts')
      writeInventory(mainF, ['app-tasks', 'app-docs'], [])
      writeInventory(okF, ['app-tasks', 'app-docs'], [])
      writeInventory(badF, ['app-tasks'], ['app-docs'])
      writeSlots(slotsF, ['app-tasks', 'app-docs'])

      const ok = run('bun', [COMPARE_TS, mainF, okF, slotsF])
      expect(ok.code).toBe(0)
      expect(ok.out).toContain('ROUTE-SLOT RATCHET: OK')

      const bad = run('bun', [COMPARE_TS, mainF, badF, slotsF])
      expect(bad.code).toBe(1)
      expect(bad.out).toContain('ROUTE-SLOT RATCHET: FAIL')
      expect(bad.out).toContain('app-docs')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  test('an EMPTY registry is refused (exit 2), never a silent pass', () => {
    const dir = mkdtempSync(join(tmpdir(), 'route-slot-ratchet-empty-'))
    try {
      const mainF = join(dir, 'main-inventory.ts')
      const headF = join(dir, 'head-inventory.ts')
      const slotsF = join(dir, 'slots.ts')
      writeInventory(mainF, ['app-tasks'], [])
      writeInventory(headF, [], ['app-tasks'])
      writeSlots(slotsF, [])
      const r = run('bun', [COMPARE_TS, mainF, headF, slotsF])
      expect(r.code).toBe(2)
      expect(r.out).toContain('declares no composed slots')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

describe('route-slot ratchet guard (shell, against a throwaway git repo)', () => {
  test('the git plumbing catches a demotion on a branch, and skips on main', () => {
    const dir = mkdtempSync(join(tmpdir(), 'route-slot-ratchet-git-'))
    try {
      mkdirSync(join(dir, 'open', '__tests__'), { recursive: true })
      mkdirSync(join(dir, 'gateway', 'http'), { recursive: true })
      const invRel = 'open/__tests__/route-slot-coverage-inventory.ts'
      const slotsRel = 'gateway/http/route-slots.ts'
      writeInventory(join(dir, invRel), ['app-tasks', 'app-docs'], [])
      writeSlots(join(dir, slotsRel), ['app-tasks', 'app-docs'])

      git(dir, 'init', '-q', '-b', 'main')
      git(dir, 'config', 'user.email', 'ci@example.com')
      git(dir, 'config', 'user.name', 'ci')
      git(dir, 'add', '-A')
      git(dir, 'commit', '-q', '-m', 'baseline')

      const env = {
        ROUTE_SLOT_RATCHET_ROOT: dir,
        ROUTE_SLOT_RATCHET_MAIN_REF: 'main',
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

      // Branch off and demote a rung into the allowlist.
      git(dir, 'checkout', '-q', '-b', 'demote')
      writeInventory(join(dir, invRel), ['app-tasks'], ['app-docs'])
      git(dir, 'add', '-A')
      git(dir, 'commit', '-q', '-m', 'demote app-docs')

      const demoted = runGuard()
      expect(demoted.code).toBe(1)
      expect(demoted.out).toContain('app-docs')

      // The temp copy of main's inventory must not survive the run — a stray .ts
      // in the tree would be picked up by typecheck on the next job.
      const leftovers = run('bash', ['-c', `ls -A "${dir}" | grep route-slot-inventory-main || true`])
      expect(leftovers.out.trim()).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    // Generous: each assertion spawns `bun` or `git`, and the cost of being wrong
    // here is a flaky red on a contended runner — which is how a gate stops being
    // believed. Bounded all the same, so a wedge reports rather than hangs.
  }, 60_000)
})
