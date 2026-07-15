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

import { newCredentialPool } from '@neutronai/runtime/credential-pool.ts'
import type { Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import type { ClaudeCodeSubstrateOptions } from '@neutronai/runtime/adapters/claude-code/index.ts'
import type { OpenWiringContext } from '../wiring/context.ts'
import { wireMemory } from '../wiring/memory.ts'
import { workBoardScopeKey } from '@neutronai/work-board/store.ts'

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

/** A handle whose token stream is a positive correction verdict — makes the
 *  reflection judge detect a correction so `emitLearning` fires. */
function correctionHandle(instanceId: string): SessionHandle {
  const events = (async function* (): AsyncGenerator<Event, void, void> {
    yield {
      kind: 'token',
      text: '{"is_correction":true,"wrong":"used spaces","right":"use tabs","why":"repo convention"}',
    }
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

  // RC2 — the agent-nexus emitter is behind the shared perfect-recall flag.
  test('perfect-recall OFF (default): no nexus store, no extra cleanup', async () => {
    const w = wireMemory(makeCtx())
    try {
      expect(w.nexus).toBeNull()
      // Unchanged: GBrain close + Cores fan-out stop.
      expect(w.cleanups.length).toBe(2)
    } finally {
      await runCleanups(w.cleanups)
    }
  }, 15_000)

  test('perfect-recall ON: nexus store built + torn down via cleanups', async () => {
    const w = wireMemory(makeCtx({ env: { NEUTRON_PERFECT_RECALL: '1' } as NodeJS.ProcessEnv }))
    try {
      expect(w.nexus).not.toBeNull()
      // The nexus closeAll hook is registered between GBrain and the fan-out.
      expect(w.cleanups.length).toBe(3)
    } finally {
      await runCleanups(w.cleanups)
    }
  }, 15_000)

  // RC2 boundary — a GENERAL-topic correction must land under the CANONICAL
  // project scope `wireMemory` derives (`workBoardScopeKey(project_slug, scope)`),
  // the SAME key trident stamps on a General run's `project_slug`, so RC3 reads
  // both from ONE `.nexus`. Drives the REAL `emitLearning` mapping via a
  // correction-returning judge substrate — regresses if memory.ts reverts to the
  // raw literal `'general'` scope.
  test('a General correction lands under workBoardScopeKey(project_slug, "general") — not literal "general"', async () => {
    const substrateFactory = (opts: ClaudeCodeSubstrateOptions): Substrate => ({
      // The reflection judge parses this JSON; a token event carries it.
      start: () => correctionHandle(opts.substrate_instance_id),
    })
    const w = wireMemory(
      makeCtx({
        env: { NEUTRON_PERFECT_RECALL: '1' } as NodeJS.ProcessEnv,
        substrateFactory,
      }),
    )
    try {
      expect(w.nexus).not.toBeNull()
      // The General topic passes scope='general' (turn.project_id ?? 'general').
      w.reflection.onTurnComplete({
        user_text: 'no, use tabs not spaces',
        agent_text: 'I indented with spaces.',
        scope: 'general',
      })

      // makeCtx sets project_slug='owner'; General collapses to it on BOTH sides.
      const canonical = workBoardScopeKey('owner', 'general')
      expect(canonical).toBe('owner')
      expect(canonical).toBe(workBoardScopeKey('owner', undefined)) // == trident General key
      let rows: Awaited<ReturnType<NonNullable<typeof w.nexus>['readRecent']>> = []
      for (let i = 0; i < 200; i++) {
        rows = await w.nexus!.readRecent(canonical, { limit: 100 })
        if (rows.length >= 1) break
        await new Promise((res) => setTimeout(res, 5))
      }
      expect(rows).toHaveLength(1)
      expect(rows[0]?.kind).toBe('learning')
      expect(rows[0]?.actor_kind).toBe('reflection')
      // The divergent literal scope must be EMPTY.
      expect(await w.nexus!.readRecent('general', { limit: 100 })).toEqual([])
    } finally {
      await runCleanups(w.cleanups)
    }
  }, 15_000)

  // Security boundary (mirrors open-wiring-substrates.test.ts): the native-MCP
  // tool bridge is the owner conversational `cc-agent-*` REPL ONLY. The
  // background `cc-scribe-*` extraction and `cc-reflection-*` correction-judge
  // substrates run one-shot work over untrusted-ish content and MUST NOT opt
  // into the bridge; both are per-call `ephemeral`. `buildLlmCallSubstrate`
  // invokes the fake factory LAZILY (on `start()`), so we DISPATCH each
  // substrate through its consumer — scribe via the awaitable `extractAndWrite`,
  // reflection via `onTurnComplete` (fire-and-forget behind a correction cue) —
  // then assert the captured ClaudeCodeSubstrateOptions. A future mutation that
  // adds `enableToolBridge: true` to either memory substrate fails HERE (the
  // presence/cleanup assertions above would not catch it).
  test('memory substrates never opt into the tool bridge; both are ephemeral', async () => {
    const captured: ClaudeCodeSubstrateOptions[] = []
    const substrateFactory = (opts: ClaudeCodeSubstrateOptions): Substrate => {
      captured.push(opts)
      return { start: () => cannedHandle(opts.substrate_instance_id) }
    }
    const w = wireMemory(makeCtx({ substrateFactory }))
    try {
      // Drive the scribe extraction (awaitable → deterministic dispatch). The
      // text must clear SCRIBE_MIN_CHARS (80) or `shouldExtract` filters it out
      // before any substrate dispatch.
      await w.scribe!.extractAndWrite({
        text: 'Ada Lovelace is the lead engineer at Analytical Engines Incorporated, headquartered in central London, and she personally mentors the whole platform team.',
      })
      // Drive the reflection judge: a cue-bearing turn passes the deterministic
      // pre-gate and fires the (fire-and-forget) detection; poll until its
      // substrate.start() records the opts.
      w.reflection.onTurnComplete({
        user_text: 'No, you should always use British spelling from now on.',
        agent_text: 'I used American spelling.',
      })
      for (let i = 0; i < 200; i++) {
        if (captured.some((o) => o.substrate_instance_id === 'cc-reflection-owner')) break
        await Bun.sleep(5)
      }

      const scribeOpts = captured.find((o) => o.substrate_instance_id === 'cc-scribe-owner')
      const reflectionOpts = captured.find((o) => o.substrate_instance_id === 'cc-reflection-owner')
      // Both background substrates were dispatched…
      expect(scribeOpts).toBeDefined()
      expect(reflectionOpts).toBeDefined()
      // …NEITHER enables the tool bridge (owner conversational REPL only)…
      expect(scribeOpts!.enableToolBridge).not.toBe(true)
      expect(reflectionOpts!.enableToolBridge).not.toBe(true)
      // …and BOTH are per-call ephemeral (one-shot isolation).
      expect(scribeOpts!.ephemeral).toBe(true)
      expect(reflectionOpts!.ephemeral).toBe(true)
    } finally {
      await runCleanups(w.cleanups)
    }
  }, 15_000)
})
