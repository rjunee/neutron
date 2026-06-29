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

  test('no overlay → only the enforce-reply Stop hook (no permissions, no PreToolUse)', () => {
    const dir = freshDir()
    const settingsPath = join(dir, 'settings.json')
    buildSettings({ settingsPath, hookPath: '/abs/hook.ts' })
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(parsed.permissions).toBeUndefined()
    expect(parsed.hooks.PreToolUse).toBeUndefined()
    expect(parsed.hooks.Stop).toBeDefined()
  })

  test('trident auto-mode overlay folds in permissions + a PreToolUse deny-guard, PRESERVING the Stop hook', () => {
    const dir = freshDir()
    const settingsPath = join(dir, 'settings.json')
    buildSettings({
      settingsPath,
      hookPath: '/abs/hook.ts',
      overlay: {
        permissions: { defaultMode: 'dontAsk', allow: ['Workflow', 'Bash(git:*)'], deny: ['Bash(sudo:*)'] },
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'bun /abs/deny-guard.ts' }] }],
        },
      },
    })
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'))
    // Auto-mode permissions land verbatim.
    expect(parsed.permissions.defaultMode).toBe('dontAsk')
    expect(parsed.permissions.allow).toContain('Workflow')
    expect(parsed.permissions.deny).toContain('Bash(sudo:*)')
    // The PreToolUse deny-guard is wired.
    expect(parsed.hooks.PreToolUse[0].matcher).toBe('Bash')
    expect(parsed.hooks.PreToolUse[0].hooks[0].command).toBe('bun /abs/deny-guard.ts')
    // …and the enforce-reply Stop hook is STILL present (the dev-channel
    // exactly-one-reply invariant must hold for the launcher turn too).
    expect(parsed.hooks.Stop[0].hooks[0].command).toBe('bun /abs/hook.ts')
  })
})
