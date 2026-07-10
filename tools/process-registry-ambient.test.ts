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
  touchLiveProcessSafe,
  unregisterLiveProcessSafe,
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

  test('touch bumps activity; unregister drops the entry', () => {
    let now = 1_000
    const reg = new ProcessRegistry({ now: () => now })
    clears.push(pushAmbientProcessRegistry(reg))
    registerLiveProcessSafe({ name: 'sess-1', pid: 1, tool_name: 'cc-repl' })
    now = 5_000
    touchLiveProcessSafe('sess-1')
    expect(reg.list()[0]!.last_activity_at).toBe(5_000)
    unregisterLiveProcessSafe('sess-1')
    expect(reg.size()).toBe(0)
  })

  test('guarded no-op when no ambient registry is registered (LLM-less / unit)', () => {
    expect(resolveAmbientProcessRegistry()).toBeNull()
    // Must not throw.
    expect(() => registerLiveProcessSafe({ name: 'x', pid: 1, tool_name: 't' })).not.toThrow()
    expect(() => touchLiveProcessSafe('x')).not.toThrow()
    expect(() => unregisterLiveProcessSafe('x')).not.toThrow()
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
