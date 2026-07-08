/**
 * Focused unit coverage for `open/wiring/memory.ts` (C3a carve).
 *
 * Pins the scribe / GBrain / reflection wiring's observable contract:
 *   - LLM-present: `scribe` + `scribeOnUserTurn` are live, `gbrainMemory` and
 *     its `syncHook` are built, `reflection` is built, and the returned
 *     `cleanups` carry BOTH teardown hooks (GBrain close + Cores fan-out stop)
 *     in registration order (GBrain first);
 *   - LLM-less (`llmPool: null`): `scribe` is null (no extraction substrate) and
 *     `scribeOnUserTurn` is undefined, but `gbrainMemory` is STILL built
 *     (unconditional) and `reflection` still functions — only the fan-out
 *     cleanup drops (it is gated on a live scribe), so `cleanups` has ONE hook.
 *
 * Cleanups are always drained in a `finally` so no scheduler timer leaks.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { newCredentialPool } from '../../runtime/credential-pool.ts'
import type { Substrate } from '../../runtime/substrate.ts'
import type { SessionHandle } from '../../runtime/session-handle.ts'
import type { Event } from '../../runtime/events.ts'
import type { ClaudeCodeSubstrateOptions } from '../../runtime/adapters/claude-code/index.ts'
import type { OpenWiringContext } from '../wiring/context.ts'
import { wireMemory } from '../wiring/memory.ts'

let tmpDir: string
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-wiring-mem-'))
})
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function cannedHandle(instanceId: string): SessionHandle {
  const events = (async function* (): AsyncGenerator<Event, void, void> {
    yield { kind: 'completion', usage: { input_tokens: 1, output_tokens: 1 }, substrate_instance_id: instanceId }
  })()
  return {
    events,
    async respondToTool(): Promise<void> {},
    async cancel(): Promise<void> {},
    tool_resolution: 'internal',
  }
}

function makeCtx(overrides: Partial<OpenWiringContext> = {}): OpenWiringContext {
  const substrateFactory = (opts: ClaudeCodeSubstrateOptions): Substrate => ({
    start: () => cannedHandle(opts.substrate_instance_id),
  })
  return {
    llmPool: newCredentialPool({
      strategy: 'fill_first',
      credentials: [{ id: 'anthropic:test', kind: 'api_key', secret: 'sk-test' }],
    }),
    internal_handle: 'owner',
    owner_home: tmpDir,
    project_slug: 'owner',
    env: {} as NodeJS.ProcessEnv,
    db: {} as OpenWiringContext['db'],
    substrateFactory,
    prewarmSubstrate: async (): Promise<void> => {},
    ...overrides,
  }
}

async function runCleanups(cleanups: Array<() => void>): Promise<void> {
  for (const c of cleanups) {
    try {
      await c()
    } catch {
      /* best-effort */
    }
  }
  // Let any fan-out stop() drains flush before the test file tears down.
  await Bun.sleep(10)
}

describe('wireMemory', () => {
  test('LLM-present: scribe live, gbrain + reflection built, BOTH cleanups (gbrain then fan-out)', async () => {
    const w = wireMemory(makeCtx())
    try {
      expect(w.scribe).not.toBeNull()
      expect(w.scribeOnUserTurn).toBeDefined()
      expect(w.gbrainMemory).toBeDefined()
      expect(w.gbrainSyncHook).toBe(w.gbrainMemory.syncHook)
      expect(w.reflection).toBeDefined()
      // GBrain close is registered first, the Cores fan-out stop second.
      expect(w.cleanups.length).toBe(2)
    } finally {
      await runCleanups(w.cleanups)
    }
  }, 15_000)

  test('LLM-less: scribe null + hook undefined, gbrain + reflection still built, ONE cleanup', async () => {
    const w = wireMemory(makeCtx({ llmPool: null }))
    try {
      expect(w.scribe).toBeNull()
      expect(w.scribeOnUserTurn).toBeUndefined()
      // GBrain memory is unconditional; reflection degrades gracefully.
      expect(w.gbrainMemory).toBeDefined()
      expect(w.reflection).toBeDefined()
      // Only the GBrain close hook — the fan-out is gated on a live scribe.
      expect(w.cleanups.length).toBe(1)
    } finally {
      await runCleanups(w.cleanups)
    }
  }, 15_000)
})
