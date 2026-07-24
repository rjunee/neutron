/**
 * build-live-agent-turn-context-reset.test.ts — Layer B rehydration seam.
 *
 * When the periodic policy `/clear`-s a warm orchestrator session for scope S, it
 * fires `contextResetSignal` with S; the runner un-marks warm every topic whose
 * turns run in S, so its NEXT turn re-composes as a COLD first turn (full grounding
 * re-assembled). This test uses the memory-index block as the COLD-ONLY signal
 * (it folds into the cold-turn `instance_fragments` only, never a warm splice):
 *   turn 1 (cold)  → prompt carries <memory_index>
 *   turn 2 (warm)  → prompt is user text, NO <memory_index>
 *   fire signal for the topic's scope
 *   turn 3 (cold again) → <memory_index> re-composed.
 * Scope isolation: a second topic in a DIFFERENT scope stays warm. An unknown
 * scope is a no-op.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ButtonStore } from '@neutronai/channels/button-store.ts'
import type { ChatOutbound } from '@neutronai/landing/server.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import { buildLiveAgentTurn } from '../build-live-agent-turn.ts'
import type { LiveAgentTurnRequest } from '../../http/chat-bridge.ts'

let tmp: string
let db: ProjectDb
let store: ButtonStore
const now = 1_000_000

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-lat-cr-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  store = new ButtonStore({ db, now: () => now })
})
afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function makeStubSubstrate(specs: AgentSpec[]): Substrate {
  return {
    start(spec: AgentSpec): SessionHandle {
      specs.push(spec)
      const events = (async function* (): AsyncGenerator<Event, void, void> {
        yield { kind: 'token', text: 'ok' }
        yield {
          kind: 'completion',
          usage: { input_tokens: 1, output_tokens: 1 },
          substrate_instance_id: 'stub',
        }
      })()
      return {
        events,
        async respondToTool(): Promise<void> {},
        async cancel(): Promise<void> {},
        tool_resolution: 'internal',
      }
    },
  }
}

/**
 * A substrate whose per-turn generator invokes `beforeCompletion(callIndex)` just
 * BEFORE yielding completion — the seam a test uses to fire a context-reset signal
 * WHILE a turn is in flight (simulating a sweep `/clear` landing mid-turn, after the
 * runner already read `isColdFirstTurn` and built its prompt).
 */
function makeRacingSubstrate(
  specs: AgentSpec[],
  beforeCompletion: (callIndex: number) => void,
): Substrate {
  let calls = 0
  return {
    start(spec: AgentSpec): SessionHandle {
      const callIndex = calls++
      specs.push(spec)
      const events = (async function* (): AsyncGenerator<Event, void, void> {
        yield { kind: 'token', text: 'ok' }
        beforeCompletion(callIndex)
        yield {
          kind: 'completion',
          usage: { input_tokens: 1, output_tokens: 1 },
          substrate_instance_id: 'stub',
        }
      })()
      return {
        events,
        async respondToTool(): Promise<void> {},
        async cancel(): Promise<void> {},
        tool_resolution: 'internal',
      }
    },
  }
}

/**
 * A substrate whose per-turn generator yields one token, then invokes
 * `onBeforeCompletion(callIndex)`; if that returns a string the generator THROWS
 * `new Error(<string>)` INSTEAD of completing — the seam a test uses to fire a
 * reset signal mid-flight AND then simulate a freeze-timeout on that same dispatch
 * (so the runner's silent auto-retry re-enters the dispatch loop). A non-string
 * return completes normally.
 */
function makeRacingThrowSubstrate(
  specs: AgentSpec[],
  onBeforeCompletion: (callIndex: number) => string | void,
): Substrate {
  let calls = 0
  return {
    start(spec: AgentSpec): SessionHandle {
      const callIndex = calls++
      specs.push(spec)
      const events = (async function* (): AsyncGenerator<Event, void, void> {
        yield { kind: 'token', text: 'ok' }
        const throwMsg = onBeforeCompletion(callIndex)
        if (typeof throwMsg === 'string') throw new Error(throwMsg)
        yield {
          kind: 'completion',
          usage: { input_tokens: 1, output_tokens: 1 },
          substrate_instance_id: 'stub',
        }
      })()
      return {
        events,
        async respondToTool(): Promise<void> {},
        async cancel(): Promise<void> {},
        tool_resolution: 'internal',
      }
    },
  }
}

function makeTurn(
  sent: ChatOutbound[],
  opts: { user_text: string; topic_id: string; project_id?: string },
): LiveAgentTurnRequest {
  const turn: LiveAgentTurnRequest = {
    project_slug: 'alice',
    user_id: 'u-1',
    topic_id: opts.topic_id,
    user_text: opts.user_text,
    send: (e) => sent.push(e),
    observed_at: now,
  }
  if (opts.project_id !== undefined) turn.project_id = opts.project_id
  return turn
}

/** A test-controllable context-reset signal bus. */
function makeSignal(): {
  signal: { subscribe(l: (scope: string) => void): void }
  fire: (scope: string) => void
} {
  const listeners = new Set<(scope: string) => void>()
  return {
    signal: { subscribe: (l) => { listeners.add(l) } },
    fire: (scope) => { for (const l of listeners) l(scope) },
  }
}

const INDEX = '<memory_index>\nCOLD-ONLY-MARKER\n</memory_index>'

describe('Layer B — context-reset rehydration seam', () => {
  test('a reset signal for a topic scope makes its next turn re-compose COLD (full re-grounding)', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    let indexCalls = 0
    const bus = makeSignal()
    const run = buildLiveAgentTurn({
      substrate: makeStubSubstrate(specs),
      personaLoader: { async load() { return '' } },
      memoryIndexSnapshot: async () => {
        indexCalls += 1
        return INDEX
      },
      contextResetSignal: bus.signal,
      buttonStore: store,
      project_slug: 'alice',
      owner_home: tmp,
      model: 'test-model',
      now: () => now,
    })

    // Turn 1 (cold): the memory index is composed into the first-turn prefix.
    await run(makeTurn(sent, { user_text: 'first', topic_id: 't1', project_id: 'proj-A' }))
    expect(specs[0]!.prompt).toContain('COLD-ONLY-MARKER')

    // Turn 2 (warm): no cold-only block; the prompt is the user text.
    await run(makeTurn(sent, { user_text: 'second', topic_id: 't1', project_id: 'proj-A' }))
    expect(specs[1]!.prompt).not.toContain('<memory_index>')
    expect(specs[1]!.prompt).toContain('second')
    expect(indexCalls).toBe(1) // consulted only on the cold turn so far

    // The policy reset this scope → fire the rehydration signal.
    bus.fire('proj-A')

    // Turn 3: re-composed COLD — the full grounding (memory index) is back.
    await run(makeTurn(sent, { user_text: 'third', topic_id: 't1', project_id: 'proj-A' }))
    expect(specs[2]!.prompt).toContain('COLD-ONLY-MARKER')
    expect(indexCalls).toBe(2) // the cold seam ran again
  })

  test('scope isolation — a reset for scope A leaves a topic in scope B warm', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const bus = makeSignal()
    const run = buildLiveAgentTurn({
      substrate: makeStubSubstrate(specs),
      personaLoader: { async load() { return '' } },
      memoryIndexSnapshot: async () => INDEX,
      contextResetSignal: bus.signal,
      buttonStore: store,
      project_slug: 'alice',
      owner_home: tmp,
      model: 'test-model',
      now: () => now,
    })

    // Warm BOTH topics: t1 in scope proj-A, t2 in scope proj-B.
    await run(makeTurn(sent, { user_text: 'a1', topic_id: 't1', project_id: 'proj-A' })) // cold
    await run(makeTurn(sent, { user_text: 'a2', topic_id: 't1', project_id: 'proj-A' })) // warm
    await run(makeTurn(sent, { user_text: 'b1', topic_id: 't2', project_id: 'proj-B' })) // cold
    await run(makeTurn(sent, { user_text: 'b2', topic_id: 't2', project_id: 'proj-B' })) // warm

    // Reset ONLY scope proj-A.
    bus.fire('proj-A')

    // t1 (scope A) re-composes cold; t2 (scope B) stays warm.
    await run(makeTurn(sent, { user_text: 'a3', topic_id: 't1', project_id: 'proj-A' }))
    await run(makeTurn(sent, { user_text: 'b3', topic_id: 't2', project_id: 'proj-B' }))
    const a3 = specs[4]!.prompt
    const b3 = specs[5]!.prompt
    expect(a3).toContain('COLD-ONLY-MARKER') // A rehydrated
    expect(b3).not.toContain('<memory_index>') // B untouched — still warm
  })

  test('reset-epoch guard — a reset that fires MID-TURN does not let the in-flight warm turn re-mark itself warm; the next turn re-composes COLD', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    let indexCalls = 0
    const bus = makeSignal()
    // On the 2nd dispatch (the warm turn, callIndex 1), fire a reset for its scope
    // WHILE it is streaming — the exact race: the runner already chose WARM and built
    // its prompt at `isColdFirstTurn`, the sweep `/clear`s + un-marks mid-flight, and
    // WITHOUT the epoch guard the turn's tail would unconditionally re-add contextSent
    // and resurrect the warm mark on the emptied REPL.
    const substrate = makeRacingSubstrate(specs, (callIndex) => {
      if (callIndex === 1) bus.fire('proj-A')
    })
    const run = buildLiveAgentTurn({
      substrate,
      personaLoader: { async load() { return '' } },
      memoryIndexSnapshot: async () => {
        indexCalls += 1
        return INDEX
      },
      contextResetSignal: bus.signal,
      buttonStore: store,
      project_slug: 'alice',
      owner_home: tmp,
      model: 'test-model',
      now: () => now,
    })

    // Turn 1 (cold) warms scope proj-A.
    await run(makeTurn(sent, { user_text: 'first', topic_id: 't1', project_id: 'proj-A' }))
    expect(specs[0]!.prompt).toContain('COLD-ONLY-MARKER')
    expect(indexCalls).toBe(1)

    // Turn 2 (warm) — the reset fires mid-dispatch. The turn built a WARM prompt
    // (no cold-only block), and the guard must NOT re-mark contextSent afterward.
    await run(makeTurn(sent, { user_text: 'second', topic_id: 't1', project_id: 'proj-A' }))
    expect(specs[1]!.prompt).not.toContain('<memory_index>')

    // Turn 3 — because the mid-turn reset's un-mark was NOT resurrected, this turn
    // re-composes COLD (full re-grounding). If the epoch guard were missing, turn 2's
    // tail would have re-marked warm and this turn would stay warm (regression).
    await run(makeTurn(sent, { user_text: 'third', topic_id: 't1', project_id: 'proj-A' }))
    expect(specs[2]!.prompt).toContain('COLD-ONLY-MARKER')
    expect(indexCalls).toBe(2) // the cold seam ran again — grounding was NOT lost
  })

  test('a signal for an unknown scope is a no-op (topic stays warm)', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const bus = makeSignal()
    const run = buildLiveAgentTurn({
      substrate: makeStubSubstrate(specs),
      personaLoader: { async load() { return '' } },
      memoryIndexSnapshot: async () => INDEX,
      contextResetSignal: bus.signal,
      buttonStore: store,
      project_slug: 'alice',
      owner_home: tmp,
      model: 'test-model',
      now: () => now,
    })

    await run(makeTurn(sent, { user_text: 'first', topic_id: 't1', project_id: 'proj-A' })) // cold
    await run(makeTurn(sent, { user_text: 'second', topic_id: 't1', project_id: 'proj-A' })) // warm

    bus.fire('proj-NEVER') // unknown scope

    await run(makeTurn(sent, { user_text: 'third', topic_id: 't1', project_id: 'proj-A' }))
    // Still warm — no cold-only block re-composed.
    expect(specs[2]!.prompt).not.toContain('<memory_index>')
    expect(specs[2]!.prompt).toContain('third')
  })

  test('dispatch-time recheck — a reset landing after a warm decision but before (re)dispatch recomposes COLD; the stale warm prompt is never executed', async () => {
    // The confirmed round-4 blocker. Turn 2 decides WARM, builds its warm prompt,
    // then its FIRST dispatch attempt fires a reset for its scope mid-flight and
    // throws a freeze-timeout (silent auto-retry). WITHOUT the per-attempt dispatch-
    // time epoch recheck the retry re-sends the STALE warm prompt into a just-
    // `/clear`ed REPL, silently dropping persona/board/memory grounding. WITH the
    // fix the retry recomposes COLD (self-grounding) and re-anchors the epoch so the
    // post-dispatch guard re-marks warm — so turn 3 is warm again.
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    let indexCalls = 0
    const bus = makeSignal()
    // callIndex 0 (turn 1 cold) → normal. callIndex 1 (turn 2 attempt-0, warm) →
    // fire the reset mid-flight, then freeze-timeout. callIndex 2+ (turn 2 retry,
    // turn 3) → normal.
    const substrate = makeRacingThrowSubstrate(specs, (callIndex) => {
      if (callIndex === 1) {
        bus.fire('proj-A')
        return 'turn timeout: inactivity'
      }
    })
    const run = buildLiveAgentTurn({
      substrate,
      personaLoader: { async load() { return '' } },
      memoryIndexSnapshot: async () => {
        indexCalls += 1
        return INDEX
      },
      contextResetSignal: bus.signal,
      buttonStore: store,
      project_slug: 'alice',
      owner_home: tmp,
      model: 'test-model',
      now: () => now,
    })

    // Turn 1 (cold) warms scope proj-A.
    await run(makeTurn(sent, { user_text: 'first', topic_id: 't1', project_id: 'proj-A' }))
    expect(specs[0]!.prompt).toContain('COLD-ONLY-MARKER')
    expect(indexCalls).toBe(1)

    // Turn 2 (warm decision): attempt-0 (specs[1]) is the doomed stale warm prompt;
    // it fires the reset + freezes; the retry (specs[2]) must recompose COLD.
    const r2 = await run(makeTurn(sent, { user_text: 'second', topic_id: 't1', project_id: 'proj-A' }))
    expect(r2.outcome).toBe('replied') // silent auto-retry recovered the turn

    // The doomed first attempt: built warm at the decision → no cold-only block.
    expect(specs[1]!.prompt).not.toContain('<memory_index>')
    // THE FIX — the retry re-composed COLD instead of re-sending the stale warm
    // prompt. (This assertion FAILS at ccc00f28: the retry re-sends the same warm
    // spec.)
    expect(specs[2]!.prompt).toContain('COLD-ONLY-MARKER')
    // Two cold composes: turn 1 + the race-recomposed retry. (No warm compose calls
    // the memory index.)
    expect(indexCalls).toBe(2)

    // Turn 3: WARM — proves the re-anchor let the post-dispatch guard re-mark warm
    // after the grounded cold retry (pre-fix would leave it cold because the mid-
    // flight un-mark was never re-anchored).
    await run(makeTurn(sent, { user_text: 'third', topic_id: 't1', project_id: 'proj-A' }))
    expect(specs[3]!.prompt).not.toContain('<memory_index>')
    expect(indexCalls).toBe(2) // turn 3 warm → no additional cold compose
  })
})
