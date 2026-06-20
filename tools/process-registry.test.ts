import { describe, expect, test } from 'bun:test'
import { ProcessRegistry, STUCK_PROCESS_INACTIVITY_MS } from './process-registry.ts'

describe('ProcessRegistry', () => {
  test('register + list', () => {
    let now = 1_000_000
    const reg = new ProcessRegistry({ now: () => now })
    reg.register({ name: 'codex-1', pid: 9001, tool_name: 'codex_exec' })
    reg.register({ name: 'codex-2', pid: 9002, tool_name: 'codex_exec' })
    expect(reg.size()).toBe(2)
    expect(reg.list().map((r) => r.name)).toEqual(['codex-1', 'codex-2'])
  })

  test('duplicate name throws', () => {
    const reg = new ProcessRegistry()
    reg.register({ name: 'a', pid: 1, tool_name: 't' })
    expect(() => reg.register({ name: 'a', pid: 2, tool_name: 't' })).toThrow(
      /already registered/,
    )
  })

  test('touch updates last_activity_at', () => {
    let now = 1_000_000
    const reg = new ProcessRegistry({ now: () => now })
    reg.register({ name: 'a', pid: 1, tool_name: 't' })
    now += 5_000
    reg.touch('a')
    const r = reg.list()[0]
    expect(r?.last_activity_at).toBe(1_005_000)
  })

  test('listStuck returns processes whose last_activity_at is older than threshold', () => {
    let now = 1_000_000
    const reg = new ProcessRegistry({ now: () => now })
    reg.register({ name: 'fresh', pid: 1, tool_name: 't' })
    now += STUCK_PROCESS_INACTIVITY_MS + 1_000
    reg.register({ name: 'still-fresh', pid: 2, tool_name: 't' })
    const stuck = reg.listStuck()
    expect(stuck.map((r) => r.name)).toEqual(['fresh'])
  })

  test('kill removes the record (even when SIGTERM hits an unknown pid)', () => {
    const reg = new ProcessRegistry()
    // pid 0 is special on POSIX; sending a signal to a non-existent pid is ESRCH which we swallow
    reg.register({ name: 'ghost', pid: 999_999_999, tool_name: 't' })
    expect(reg.kill('ghost')).toBe(true)
    expect(reg.size()).toBe(0)
  })

  test('killAll signals every record', () => {
    const reg = new ProcessRegistry()
    reg.register({ name: 'a', pid: 999_999_991, tool_name: 't' })
    reg.register({ name: 'b', pid: 999_999_992, tool_name: 't' })
    expect(reg.killAll()).toBe(2)
    expect(reg.size()).toBe(0)
  })

  test('unregister returns true when present, false when absent', () => {
    const reg = new ProcessRegistry()
    reg.register({ name: 'a', pid: 1, tool_name: 't' })
    expect(reg.unregister('a')).toBe(true)
    expect(reg.unregister('a')).toBe(false)
  })
})
