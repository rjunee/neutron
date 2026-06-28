/**
 * Unit tests for the absolute-`gbrain` reachability resolver (the runtime fix
 * for "memory silently disabled because the SERVICE PATH omits the bun
 * global-bin dir", dogfood 2026-06-28).
 *
 * Strategy: a temp dir of fake executables stands in for real install dirs, so
 * the PATH-hit / probe-fallback / none ordering is asserted deterministically
 * without touching the host's real `gbrain`. No hardcoded dates (time-rot rule).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

import {
  resolveGbrainCommand,
  resolveGbrainChildPath,
  resolveBunDir,
  gbrainProbePaths,
} from '../resolve-gbrain-command.ts'

let scratch: string

/** Drop an executable file named `name` under `dir` (created if missing). */
function fakeExe(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true })
  const p = join(dir, name)
  writeFileSync(p, '#!/bin/sh\necho ok\n')
  chmodSync(p, 0o755)
  return p
}

/** Drop a NON-executable file (exists but not runnable). */
function nonExe(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true })
  const p = join(dir, name)
  writeFileSync(p, 'not executable\n')
  chmodSync(p, 0o644)
  return p
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'resolve-gbrain-'))
})
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('resolveGbrainCommand', () => {
  test('PATH-hit → returns the PATH-resolved gbrain (honoring env.PATH)', () => {
    const binDir = join(scratch, 'pathbin')
    const onPath = fakeExe(binDir, 'gbrain')
    // BUN_INSTALL points somewhere with NO gbrain, so a hit MUST come from PATH.
    const env = { PATH: binDir, HOME: scratch, BUN_INSTALL: join(scratch, 'nobun') }
    expect(resolveGbrainCommand(env)).toBe(onPath)
  })

  test('PATH-miss → first existing probe path ($BUN_INSTALL/bin first)', () => {
    const bunInstall = join(scratch, 'bun')
    const probeHit = fakeExe(join(bunInstall, 'bin'), 'gbrain')
    // Also drop one in /opt-style dir to confirm BUN_INSTALL wins the ordering.
    fakeExe(join(scratch, 'opt'), 'gbrain')
    const env = { PATH: join(scratch, 'empty'), HOME: scratch, BUN_INSTALL: bunInstall }
    expect(resolveGbrainCommand(env)).toBe(probeHit)
  })

  test('PATH-miss, no BUN_INSTALL → falls back to $HOME/.bun/bin probe', () => {
    const homeBun = fakeExe(join(scratch, '.bun', 'bin'), 'gbrain')
    const env = { PATH: join(scratch, 'empty'), HOME: scratch }
    expect(resolveGbrainCommand(env)).toBe(homeBun)
  })

  test('nothing anywhere → null (fail-soft, no throw)', () => {
    const env = { PATH: join(scratch, 'empty'), HOME: join(scratch, 'emptyhome') }
    expect(resolveGbrainCommand(env)).toBeNull()
  })

  test('a non-executable file at a probe path is NOT accepted', () => {
    const bunInstall = join(scratch, 'bun')
    nonExe(join(bunInstall, 'bin'), 'gbrain') // exists but 0644
    const env = { PATH: join(scratch, 'empty'), HOME: scratch, BUN_INSTALL: bunInstall }
    expect(resolveGbrainCommand(env)).toBeNull()
  })
})

describe('gbrainProbePaths', () => {
  test('ordered, bun global-bin first, deduped when BUN_INSTALL == $HOME/.bun', () => {
    const env = { HOME: '/home/u', BUN_INSTALL: '/home/u/.bun' }
    const paths = gbrainProbePaths(env)
    expect(paths[0]).toBe('/home/u/.bun/bin/gbrain')
    // No duplicate even though BUN_INSTALL/bin === $HOME/.bun/bin.
    expect(paths.filter((p) => p === '/home/u/.bun/bin/gbrain')).toHaveLength(1)
    expect(paths).toContain('/usr/local/bin/gbrain')
    expect(paths).toContain('/opt/homebrew/bin/gbrain')
    expect(paths).toContain('/home/u/.local/bin/gbrain')
  })

  test('distinct BUN_INSTALL keeps both it and $HOME/.bun', () => {
    const env = { HOME: '/home/u', BUN_INSTALL: '/opt/bun' }
    const paths = gbrainProbePaths(env)
    expect(paths[0]).toBe('/opt/bun/bin/gbrain')
    expect(paths).toContain('/home/u/.bun/bin/gbrain')
  })
})

describe('resolveGbrainChildPath', () => {
  test('prepends the gbrain dir + a bun dir to the inherited PATH', () => {
    const command = '/opt/bun/bin/gbrain'
    const env = { PATH: '/usr/bin:/bin' }
    const out = resolveGbrainChildPath({ command, env })
    const entries = out.split(delimiter)
    // The gbrain command's dir must be present (so a sibling `bun` resolves too).
    expect(entries).toContain('/opt/bun/bin')
    // The running bun's dir (process.execPath) is prepended for the shebang.
    expect(entries).toContain(dirname(process.execPath))
    // The inherited PATH is preserved at the tail.
    expect(out.endsWith('/usr/bin:/bin')).toBe(true)
  })

  test('no duplicate dirs even when gbrain dir already on PATH', () => {
    const command = '/usr/local/bin/gbrain'
    const env = { PATH: '/usr/local/bin:/usr/bin' }
    const entries = resolveGbrainChildPath({ command, env }).split(delimiter)
    expect(entries.filter((d) => d === '/usr/local/bin')).toHaveLength(1)
  })

  test('null command → only the bun dir is prepended (no bogus "." entry)', () => {
    const entries = resolveGbrainChildPath({ command: null, env: { PATH: '/usr/bin' } }).split(delimiter)
    expect(entries).not.toContain('.')
    expect(entries).toContain('/usr/bin')
  })

  test('a bare (non-absolute) command is ignored — no "." prepended', () => {
    const entries = resolveGbrainChildPath({ command: 'gbrain', env: { PATH: '/usr/bin' } }).split(delimiter)
    expect(entries).not.toContain('.')
  })
})

describe('resolveBunDir', () => {
  test("returns the running bun's dir (process.execPath) by default", () => {
    expect(resolveBunDir({})).toBe(dirname(process.execPath))
  })
})
