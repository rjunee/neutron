/**
 * Focused unit coverage for `open/wiring/memory.ts` (C3a carve).
 *
 * Pins the scribe / GBrain / reflection wiring's observable contract. The
 * perfect-recall lane is the BASE behavior now (managed SPEC Decisions Log
 * 2026-07-20, P0-4 — no flag), so the memory-index wrap + the agent-nexus store
 * are ALWAYS built:
 *   - LLM-present: `scribe` + `scribeOnUserTurn` are live, `gbrainMemory` and its
 *     memory-index-wrapped `syncHook` are built, `reflection` + the nexus store
 *     are built, and the returned `cleanups` carry THREE teardown hooks (GBrain
 *     close → nexus closeAll → Cores fan-out stop) in registration order;
 *   - LLM-less (`llmPool: null`): `scribe` is null (no extraction substrate) and
 *     `scribeOnUserTurn` is undefined, but `gbrainMemory` + the nexus store are
 *     STILL built (unconditional) and `reflection` still functions — only the
 *     fan-out cleanup drops (it is gated on a live scribe), so `cleanups` has TWO
 *     hooks (GBrain close + nexus closeAll).
 *
 * Cleanups are always drained in a `finally` so no scheduler timer leaks.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { newCredentialPool } from '@neutronai/runtime/credential-pool.ts'
import type { Substrate, AgentSpec } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import type { ClaudeCodeSubstrateOptions } from '@neutronai/runtime/adapters/claude-code/index.ts'
import type { OpenWiringContext } from '../wiring/context.ts'
import { FAST_MODEL, getBestModel } from '@neutronai/runtime/models.ts'
import { wireMemory } from '../wiring/memory.ts'
import { SUPERSEDE_GUIDANCE } from '@neutronai/scribe/extract.ts'
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
    owner_handle: 'owner',
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
  test('LLM-present: scribe live, gbrain + reflection + nexus built, THREE cleanups (gbrain, nexus, fan-out)', async () => {
    const w = wireMemory(makeCtx())
    try {
      expect(w.scribe).not.toBeNull()
      expect(w.scribeOnUserTurn).toBeDefined()
      expect(w.gbrainMemory).toBeDefined()
      // The memory-index wrap is ALWAYS applied now → the exposed syncHook is the
      // wrapper, NOT the raw gbrain hook, and the cold-turn read seam is live.
      expect(w.gbrainSyncHook).not.toBe(w.gbrainMemory.syncHook)
      expect(w.memoryIndexRead).toBeDefined()
      expect(w.reflection).toBeDefined()
      expect(w.nexus).not.toBeNull()
      // GBrain close registered first, nexus closeAll second, Cores fan-out third.
      expect(w.cleanups.length).toBe(3)
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
      // The nexus store is built unconditionally (not gated on a live scribe).
      expect(w.nexus).not.toBeNull()
      // GBrain close + nexus closeAll — the fan-out cleanup is gated on a live scribe.
      expect(w.cleanups.length).toBe(2)
    } finally {
      await runCleanups(w.cleanups)
    }
  }, 15_000)

  // RC2 — the agent-nexus emitter is the base behavior now (always built).
  test('nexus store always built + torn down via cleanups', async () => {
    const w = wireMemory(makeCtx())
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

  // RB4 — the supersede guidance actually REACHES the wired scribe. A
  // prompt-capturing factory proves that `wireMemory` builds a scribe whose
  // extraction prompt always carries the guidance (belief evolution is the base
  // behavior now): a mutation that stopped splicing the guidance fails THIS test.
  const captureScribePrompts = (): {
    prompts: string[]
    factory: (opts: ClaudeCodeSubstrateOptions) => Substrate
  } => {
    const prompts: string[] = []
    const factory = (opts: ClaudeCodeSubstrateOptions): Substrate => ({
      start: (spec: AgentSpec): SessionHandle => {
        if (typeof spec.prompt === 'string') prompts.push(spec.prompt)
        return cannedHandle(opts.substrate_instance_id)
      },
    })
    return { prompts, factory }
  }
  const SCRIBE_TURN =
    'Alice Ng moved from OldCo to NewCo this quarter and now leads their platform reliability team.'

  test('RB4: the wired scribe prompt always carries the supersede guidance', async () => {
    const { prompts, factory } = captureScribePrompts()
    const w = wireMemory(makeCtx({ substrateFactory: factory }))
    try {
      expect(w.scribe).not.toBeNull()
      await w.scribe!.extractAndWrite({ text: SCRIBE_TURN, observed_at: Date.now() })
      // The dispatched extraction prompt carries the supersede guidance.
      expect(prompts.length).toBeGreaterThan(0) // the scribe DID dispatch…
      expect(prompts.some((p) => p.includes(SUPERSEDE_GUIDANCE))).toBe(true)
    } finally {
      await runCleanups(w.cleanups)
    }
  }, 15_000)
})

/**
 * ISSUES #493 — the fast-model pin must reach ALL THREE memory-lane call sites.
 *
 * Three modules make one-shot LLM calls for the memory lane, and all three have the
 * IDENTICAL fallback `deps.model_preference ?? [getBestModel()]`:
 * `scribe/extract.ts`, `reflection/detector.ts`, and
 * `scribe/reflect/reflect-pass.ts`. `wireMemory` pinned only the first, so the
 * correction judge (one call per completed turn) and the consolidation pass
 * (batched over the whole correction/diary history) silently ran on the FLAGSHIP
 * model. Cost-only, which is exactly why nothing failed and nobody noticed.
 *
 * These assert on the AgentSpec the REAL substrate receives at spawn, not on the
 * source text of memory.ts — a source assertion would still pass if the option
 * were renamed or dropped downstream.
 */
describe('wireMemory — the fast-model pin reaches every memory-lane call site (#493)', () => {
  /** Records `model_preference` per substrate instance id, as spawned. */
  function recordingCtx(): {
    seen: Map<string, readonly string[]>
    factory: (opts: ClaudeCodeSubstrateOptions) => Substrate
  } {
    const seen = new Map<string, readonly string[]>()
    const factory = (opts: ClaudeCodeSubstrateOptions): Substrate => ({
      start: (spec?: { model_preference?: readonly string[] }) => {
        if (spec?.model_preference !== undefined) {
          seen.set(opts.substrate_instance_id, spec.model_preference)
        }
        return correctionHandle(opts.substrate_instance_id)
      },
    })
    return { seen, factory }
  }

  test('the correction judge spawns on FAST_MODEL, not the flagship', async () => {
    const { seen, factory } = recordingCtx()
    const w = wireMemory(makeCtx({ substrateFactory: factory }))
    try {
      w.reflection.onTurnComplete({
        user_text: 'no, use tabs not spaces',
        agent_text: 'I indented with spaces.',
        scope: 'general',
      })
      let pref: readonly string[] | undefined
      for (let i = 0; i < 200; i++) {
        pref = [...seen.entries()].find(([id]) => id.startsWith('cc-reflection-'))?.[1]
        if (pref !== undefined) break
        await new Promise((res) => setTimeout(res, 5))
      }
      // If this is the flagship, the judge is billing top-tier to classify one turn.
      expect(pref).toEqual([FAST_MODEL])
    } finally {
      await runCleanups(w.cleanups)
    }
  }, 15_000)

  test('ALL THREE pins are present in the wiring — scribe included', () => {
    // THE SCRIBE PIN HAD NO COVERAGE AT ALL until this test, which a mutation run
    // exposed: deleting `model_preference: [FAST_MODEL]` from the scribe block left
    // the whole suite GREEN. It is the pin that predates #493, and it was unguarded
    // precisely because the behavioural route to it does not work in-test (scribe
    // resolves a gbrain-backed store before any LLM call, and that store is absent
    // here — no existing test in this file asserts a scribe spawn either).
    //
    // So: three source-scoped assertions, one per block, each naming its block so a
    // pin cannot be counted twice. Weaker than the behavioural judge test above, and
    // labelled as such — but a weak guard on a real regression beats none, which is
    // what the mutation run found.
    const src = readFileSync(join(import.meta.dir, '..', 'wiring', 'memory.ts'), 'utf8')
    const between = (from: string, to: string): string =>
      src.slice(src.indexOf(from), src.indexOf(to))
    const PIN = 'model_preference: [FAST_MODEL]'
    // scribe extraction
    expect(between('const scribe', 'const reflectionSubstrate')).toContain(PIN)
    // correction judge
    expect(between('const reflection: Reflection', '// Production-shape hook')).toContain(PIN)
    // consolidation pass
    expect(between('const reflectDeps', 'const reflectLoop')).toContain(PIN)
  })

  test('the consolidation pass is pinned too — asserted on SOURCE, and here is why', () => {
    // WEAKER THAN THE TEST ABOVE, DELIBERATELY, AND SAID SO. The reflect pass runs
    // off `reflectLoop`, a SupervisedLoop with only start()/stop() and an interval
    // measured in hours — there is no manual tick, so it cannot be driven to a real
    // spawn inside a test the way `onTurnComplete` can. Two other routes were
    // considered and rejected: starting the loop (waits out the interval) and
    // asserting a scribe spawn (scribe resolves a gbrain-backed store first, which
    // is absent in-test, so it never reaches an LLM call — which is why no existing
    // test in this file asserts a scribe spawn either).
    //
    // So this pins the wiring textually and names the limitation, rather than
    // dressing a source check up as behavioural coverage. The DOWNSTREAM default it
    // guards against is verified where it lives: `scribe/reflect/reflect-pass.ts`
    // falls back to `[getBestModel()]` when the option is absent.
    const src = readFileSync(join(import.meta.dir, '..', 'wiring', 'memory.ts'), 'utf8')
    const reflectDepsBlock = src.slice(src.indexOf('const reflectDeps'), src.indexOf('const reflectLoop'))
    expect(reflectDepsBlock).toContain('model_preference: [FAST_MODEL]')
  })

  test('FAST_MODEL is not accidentally the same id as the flagship', () => {
    // Otherwise both assertions above would pass while pinning nothing — the
    // "test cannot fail for the reason it claims" shape, applied to a constant.
    expect(FAST_MODEL).not.toBe(getBestModel())
  })
})

/**
 * THE OTHER HALF OF THE FRONTIER-MODEL FLOOR, and it belongs HERE.
 *
 * `open/__tests__/open-wiring-substrates.test.ts` asserts that only the owner's
 * chat substrate carries `frontier_model_floor` — but it builds `wireSubstrates`
 * ONLY, and the deliberate fast-tier callers the counter-assertion is about are
 * built by `wireMemory`, in this file's module. So the substrates test's
 * "…and no other substrate does" clause never actually looked at the three call
 * sites it was protecting: flipping the scribe extractor or the correction judge
 * onto the chat profile would not have failed it.
 *
 * The floor would be a real regression on these three, not a cosmetic one: they
 * are `FAST_MODEL` on purpose (a judge classifying one turn, an extractor per
 * chat message, a consolidation pass over the whole history), and a floor would
 * clamp every one of them up to the flagship — the #493 cost defect, reintroduced
 * from the opposite direction.
 */
describe('wireMemory — no memory substrate carries the frontier-model floor', () => {
  test('the correction judge is built WITHOUT the floor and spawns on the fast tier', async () => {
    // Behavioural, through the real `wireMemory` → `buildLlmCallSubstrate` path:
    // the floor is derived from the PROFILE, so this fails if the block ever
    // switches to `PROFILE_WARM_CHAT` — the exact mutation the substrates test
    // cannot see.
    const captured: ClaudeCodeSubstrateOptions[] = []
    const substrateFactory = (opts: ClaudeCodeSubstrateOptions): Substrate => {
      captured.push(opts)
      return { start: () => correctionHandle(opts.substrate_instance_id) }
    }
    const w = wireMemory(makeCtx({ substrateFactory }))
    try {
      w.reflection.onTurnComplete({
        user_text: 'no, use tabs not spaces',
        agent_text: 'I indented with spaces.',
        scope: 'general',
      })
      let judge: ClaudeCodeSubstrateOptions | undefined
      for (let i = 0; i < 200; i++) {
        judge = captured.find((o) => o.substrate_instance_id.startsWith('cc-reflection-'))
        if (judge !== undefined) break
        await new Promise((res) => setTimeout(res, 5))
      }
      expect(judge).toBeDefined()
      expect(judge!.frontier_model_floor).not.toBe(true)
      // And no memory substrate dispatched during this test picked it up either.
      for (const o of captured) {
        expect(o.frontier_model_floor, o.substrate_instance_id).not.toBe(true)
      }
    } finally {
      await runCleanups(w.cleanups)
    }
  }, 15_000)

  test('all three memory call sites name the toolless-utility profile', () => {
    // Same weaker-but-honest source pin the #493 block above uses, and for the
    // same reason: the scribe and consolidation blocks cannot be driven to a real
    // spawn in-test. `PROFILE_TOOLLESS_UTILITY` is where the floor decision lives
    // (`gateway/wiring/substrate-profiles.ts` sets `frontier_model_floor: false`
    // on it, pinned by `substrate-profiles.test.ts`), so naming the profile at the
    // call site IS the answer to "does this substrate get floored".
    const src = readFileSync(join(import.meta.dir, '..', 'wiring', 'memory.ts'), 'utf8')
    const between = (from: string, to: string): string =>
      src.slice(src.indexOf(from), src.indexOf(to))
    const PROFILE = 'profile: PROFILE_TOOLLESS_UTILITY'
    expect(between('const scribeSubstrate', 'const reflectionSubstrate')).toContain(PROFILE)
    expect(between('const reflectionSubstrate', 'const reflection: Reflection')).toContain(PROFILE)
    expect(between('const reflectSubstrate', 'const reflectDeps')).toContain(PROFILE)
    // The counter-check that keeps the three assertions above meaningful: the
    // floored profile is not mentioned anywhere in the memory lane at all.
    expect(src).not.toContain('PROFILE_WARM_CHAT')
  })
})
