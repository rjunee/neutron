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

  test('listStuck returns processes whose OUTSTANDING TURN is older than threshold', () => {
    let now = 1_000_000
    const reg = new ProcessRegistry({ now: () => now })
    reg.register({ name: 'wedged', pid: 1, tool_name: 't' })
    reg.markTurnStarted('wedged', 1, 'inc:1')
    // Registered at the SAME long-ago instant and never touched since, but with
    // NO outstanding turn: the resting state of a warm pooled REPL. Never stuck.
    reg.register({ name: 'idle-warm', pid: 3, tool_name: 't' })
    now += STUCK_PROCESS_INACTIVITY_MS + 1_000
    // A turn that only just started — not stuck yet.
    reg.register({ name: 'just-started', pid: 2, tool_name: 't' })
    reg.markTurnStarted('just-started', 2, 'inc:1')
    const stuck = reg.listStuck()
    expect(stuck.map((r) => r.name)).toEqual(['wedged'])
  })

  test('markTurnStarted/markTurnSettled are pid-guarded — a respawned successor is never mutated', () => {
    const reg = new ProcessRegistry()
    reg.register({ name: 'repl', pid: 1, tool_name: 't' })
    // A respawn replaced the entry under the same name with a new pid.
    reg.unregister('repl')
    reg.register({ name: 'repl', pid: 2, tool_name: 't' })
    // The OLD child's handle must not mark or settle the NEW child's entry.
    expect(reg.markTurnStarted('repl', 1, 'old:1')).toBe(false)
    expect(reg.list()[0]?.busy_since).toBeNull()
    reg.markTurnStarted('repl', 2, 'new:1')
    expect(reg.markTurnSettled('repl', 1, 'old:1')).toBe(false)
    expect(reg.list()[0]?.busy_turn_id).toBe('new:1')
  })

  test('markTurnSettled is turn-id-guarded — a stale settle cannot clear a newer turn', () => {
    const reg = new ProcessRegistry()
    reg.register({ name: 'repl', pid: 1, tool_name: 't' })
    reg.markTurnStarted('repl', 1, 'inc:1')
    reg.markTurnStarted('repl', 1, 'inc:2')
    expect(reg.markTurnSettled('repl', 1, 'inc:1')).toBe(false)
    expect(reg.list()[0]?.busy_turn_id).toBe('inc:2')
    expect(reg.markTurnSettled('repl', 1, 'inc:2')).toBe(true)
    expect(reg.list()[0]?.busy_since).toBeNull()
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
