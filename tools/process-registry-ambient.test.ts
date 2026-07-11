/**
 * @neutronai/tools — ambient live-process registry (F4).
 *
 * The subprocess spawn chokepoint (`runtime/adapters/claude-code/persistent/
 * spawn.ts`) has no DI seam to the gateway module that owns the ProcessRegistry,
 * so it writes child PIDs through this ambient accessor. These tests prove the
 * accessor + guarded writers behave: a spawn's write reaches the ambient
 * registry the detectors read, upserts on respawn, and NEVER throws into the
 * spawn path.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import {
  ProcessRegistry,
  pushAmbientProcessRegistry,
  resolveAmbientProcessRegistry,
  registerLiveProcessSafe,
} from './process-registry.ts'

let clears: Array<() => void> = []
afterEach(() => {
  for (const c of clears) c()
  clears = []
  // Drain any leftover ambient registries so tests don't leak into each other.
  while (resolveAmbientProcessRegistry() !== null) {
    // Each push returns its own clear; if a test forgot one, pop defensively by
    // pushing+clearing a throwaway is not possible — so tests MUST register clears.
    break
  }
})

describe('ambient ProcessRegistry (F4)', () => {
  test('a spawn write reaches the ambient registry the detectors read', () => {
    const reg = new ProcessRegistry()
    clears.push(pushAmbientProcessRegistry(reg))
    expect(resolveAmbientProcessRegistry()).toBe(reg)

    registerLiveProcessSafe({ name: 'sess-1', pid: 12345, tool_name: 'cc-repl' })
    expect(reg.size()).toBe(1)
    expect(reg.list()[0]!.name).toBe('sess-1')
    expect(reg.list()[0]!.pid).toBe(12345)
  })

  test('register is UPSERT — a respawn re-using the name replaces the entry', () => {
    const reg = new ProcessRegistry()
    clears.push(pushAmbientProcessRegistry(reg))
    registerLiveProcessSafe({ name: 'sess-1', pid: 111, tool_name: 'cc-repl' })
    // Respawn: same session key, new pid — must not throw (raw register would).
    registerLiveProcessSafe({ name: 'sess-1', pid: 222, tool_name: 'cc-repl' })
    expect(reg.size()).toBe(1)
    expect(reg.list()[0]!.pid).toBe(222)
  })

  test('the handle bumps activity; unregister drops the entry', () => {
    let now = 1_000
    const reg = new ProcessRegistry({ now: () => now })
    clears.push(pushAmbientProcessRegistry(reg))
    const handle = registerLiveProcessSafe({ name: 'sess-1', pid: 1, tool_name: 'cc-repl' })
    now = 5_000
    handle.touch()
    expect(reg.list()[0]!.last_activity_at).toBe(5_000)
    handle.unregister()
    expect(reg.size()).toBe(0)
  })

  test('the handle is IDENTITY-GUARDED — a respawn under the same name is not touched or dropped by the old handle', () => {
    let now = 1_000
    const reg = new ProcessRegistry({ now: () => now })
    clears.push(pushAmbientProcessRegistry(reg))
    const oldHandle = registerLiveProcessSafe({ name: 'sess-1', pid: 1, tool_name: 'cc-repl' })
    // A respawn replaces the entry under the same name with a NEW pid.
    const newHandle = registerLiveProcessSafe({ name: 'sess-1', pid: 2, tool_name: 'cc-repl' })
    now = 9_000
    // The OLD child's late touch/unregister must NOT affect the live pid-2 entry.
    oldHandle.touch()
    expect(reg.list()[0]!.last_activity_at).toBe(1_000) // pid-2 entry untouched
    oldHandle.unregister()
    expect(reg.size()).toBe(1)
    expect(reg.list()[0]!.pid).toBe(2)
    // The NEW child's handle still operates on its own entry.
    newHandle.touch()
    expect(reg.list()[0]!.last_activity_at).toBe(9_000)
  })

  test('High 2: an old child exit does NOT empty a NEWER boot registry pushed after it registered', () => {
    const a = new ProcessRegistry()
    const clearA = pushAmbientProcessRegistry(a)
    clears.push(clearA)
    // A's child registers while A is top-of-stack — capture its ownership handle.
    const aHandle = registerLiveProcessSafe({ name: 'same', pid: 1, tool_name: 'cc-repl' })

    // A NEWER gateway boot pushes registry B and registers its own live child.
    const b = new ProcessRegistry()
    const clearB = pushAmbientProcessRegistry(b)
    clears.push(clearB)
    registerLiveProcessSafe({ name: 'same', pid: 2, tool_name: 'cc-repl' })
    expect(resolveAmbientProcessRegistry()).toBe(b)

    // A's exiting child fires its handle. A top-of-stack resolution would EMPTY B
    // (blinding B's watchdog to its live child); the bound handle only drops A's.
    aHandle.unregister()
    expect(a.size()).toBe(0) // A's own child dropped
    expect(b.size()).toBe(1) // B's live child RETAINED
    expect(b.list()[0]!.pid).toBe(2)
  })

  test('guarded no-op when no ambient registry is registered (LLM-less / unit)', () => {
    expect(resolveAmbientProcessRegistry()).toBeNull()
    // Must not throw, and the returned handle is a safe no-op.
    let handle
    expect(() => {
      handle = registerLiveProcessSafe({ name: 'x', pid: 1, tool_name: 't' })
    }).not.toThrow()
    expect(() => handle!.touch()).not.toThrow()
    expect(() => handle!.unregister()).not.toThrow()
  })

  test('stack semantics — newest wins, clears remove by identity in any order', () => {
    const a = new ProcessRegistry()
    const b = new ProcessRegistry()
    const clearA = pushAmbientProcessRegistry(a)
    const clearB = pushAmbientProcessRegistry(b)
    expect(resolveAmbientProcessRegistry()).toBe(b) // top
    // Clear the OLDER one first — the newer stays live (order-independent).
    clearA()
    expect(resolveAmbientProcessRegistry()).toBe(b)
    clearB()
    expect(resolveAmbientProcessRegistry()).toBeNull()
    // idempotent
    clearA()
    clearB()
  })
})
