import { describe, test, expect, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSettings } from '../build-settings.ts'

const dirs: string[] = []
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'build-settings-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('buildSettings — behaviour-preserving atomic write', () => {
  test('writes the Stop -> enforce-reply settings JSON and returns the path', () => {
    const dir = freshDir()
    const settingsPath = join(dir, 'settings.json')
    const out = buildSettings({ settingsPath, hookPath: '/abs/hook.ts', bunBin: 'bun' })
    expect(out).toBe(settingsPath)
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(parsed.hooks.Stop[0].hooks[0]).toEqual({
      type: 'command',
      command: 'bun /abs/hook.ts',
    })
  })

  test('leaves no staging temp behind after the write', () => {
    const dir = freshDir()
    const settingsPath = join(dir, 'settings.json')
    buildSettings({ settingsPath, hookPath: '/abs/hook.ts' })
    // The shared atomic-write leaf stages to a hidden `.settings.json.tmp-<pid>-<n>`
    // sibling and removes it after rename; only settings.json should remain.
    const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp-'))
    expect(leftovers).toEqual([])
    // The former fixed staging path must not linger either.
    expect(existsSync(`${settingsPath}.tmp`)).toBe(false)
  })

  test('repeated writes to the same path stay valid (no clobber)', () => {
    const dir = freshDir()
    const settingsPath = join(dir, 'settings.json')
    for (const bin of ['bun', 'bun-a', 'bun-b']) {
      buildSettings({ settingsPath, hookPath: '/abs/hook.ts', bunBin: bin })
    }
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(parsed.hooks.Stop[0].hooks[0].command).toBe('bun-b /abs/hook.ts')
  })
})
