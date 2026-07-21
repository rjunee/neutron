import { describe, test, expect, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
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

  test('no `permissions` key when none provided (byte-identical to pre-task-6)', () => {
    const dir = freshDir()
    const settingsPath = join(dir, 'settings.json')
    buildSettings({ settingsPath, hookPath: '/abs/hook.ts' })
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(parsed.permissions).toBeUndefined()
    expect(Object.keys(parsed)).toEqual(['hooks'])
  })
})

describe('buildSettings — task 6 (T5) write-containment permissions block', () => {
  test('emits the `permissions` block ALONGSIDE the Stop hook', () => {
    const dir = freshDir()
    const settingsPath = join(dir, 'settings.json')
    const scope = '/tmp/ritual-scope'
    const outside = '/tmp/ritual-outside'
    buildSettings({
      settingsPath,
      hookPath: '/abs/hook.ts',
      permissions: {
        allow: [`Write(${scope}/**)`, `Edit(${scope}/**)`],
        deny: [`Write(${outside}/**)`, `Edit(${outside}/**)`, 'Bash'],
      },
    })
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'))
    // Stop hook intact.
    expect(parsed.hooks.Stop[0].hooks[0]).toEqual({
      type: 'command',
      command: 'bun /abs/hook.ts',
    })
    // permissions written verbatim.
    expect(parsed.permissions.allow).toEqual([`Write(${scope}/**)`, `Edit(${scope}/**)`])
    expect(parsed.permissions.deny).toEqual([`Write(${outside}/**)`, `Edit(${outside}/**)`, 'Bash'])
  })

  test('drops empty sub-arrays so a deny-only ritual emits a minimal policy', () => {
    const dir = freshDir()
    const settingsPath = join(dir, 'settings.json')
    buildSettings({
      settingsPath,
      hookPath: '/abs/hook.ts',
      permissions: { allow: [], deny: ['Bash'], defaultMode: 'default' },
    })
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(parsed.permissions.allow).toBeUndefined()
    expect(parsed.permissions.ask).toBeUndefined()
    expect(parsed.permissions.deny).toEqual(['Bash'])
    expect(parsed.permissions.defaultMode).toBe('default')
  })

  test('permissions file is written 0600 (owner-only security policy)', () => {
    const dir = freshDir()
    const settingsPath = join(dir, 'settings.json')
    buildSettings({ settingsPath, hookPath: '/abs/hook.ts', permissions: { deny: ['Bash'] } })
    const mode = statSync(settingsPath).mode & 0o777
    expect(mode).toBe(0o600)
  })
})
