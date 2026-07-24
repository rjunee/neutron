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
})
