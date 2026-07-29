/**
 * RB1 (perfect-recall lane) — the memory-index manifest injection.
 *
 * Unlike the work board (every turn), the breadth memory-index is injected ONCE
 * per (instance, topic) session: it folds into the cold-turn `instance_fragments`
 * and is NOT re-spliced on warm turns (stable breadth, not per-turn state). This
 * test locks: cold turn carries the `<memory_index>` block, the warm turn does
 * NOT, and a throwing/absent seam degrades to no block (the turn still runs).
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
  tmp = mkdtempSync(join(tmpdir(), 'neutron-lat-mi-'))
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

function makeTurn(sent: ChatOutbound[], user_text: string): LiveAgentTurnRequest {
  return {
    project_slug: 'alice',
    user_id: 'u-1',
    topic_id: 'web:u-1',
    user_text,
    send: (e) => sent.push(e),
    observed_at: now,
  }
}

const INDEX = '<memory_index>\nINDEX-MARKER-XYZ\n</memory_index>'

describe('RB1 memory-index injection', () => {
  test('injected on the cold turn only (once per session), not warm turns', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    let calls = 0
    const run = buildLiveAgentTurn({
      substrate: makeStubSubstrate(specs),
      personaLoader: { async load() { return '' } },
      memoryIndexSnapshot: async () => {
        calls += 1
        return INDEX
      },
      buttonStore: store,
      project_slug: 'alice',
      owner_home: tmp,
      model: 'test-model',
      now: () => now,
    })

    await run(makeTurn(sent, 'first message')) // cold
    await run(makeTurn(sent, 'second message')) // warm

    expect(specs.length).toBe(2)
    // Cold turn folds it into the cacheable system prefix.
    expect(specs[0]!.prompt).toContain('INDEX-MARKER-XYZ')
    expect(specs[0]!.prompt).toContain('<memory_index>')
    // Warm turn does NOT re-splice it (breadth is stable for the session).
    expect(specs[1]!.prompt).not.toContain('<memory_index>')
    expect(specs[1]!.prompt).toContain('second message')
    // The seam is consulted only on the cold turn.
    expect(calls).toBe(1)
  })

  test('a throwing snapshot seam degrades to no block (turn still runs)', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const run = buildLiveAgentTurn({
      substrate: makeStubSubstrate(specs),
      personaLoader: { async load() { return '' } },
      memoryIndexSnapshot: () => {
        throw new Error('index read exploded')
      },
      buttonStore: store,
      project_slug: 'alice',
      owner_home: tmp,
      model: 'test-model',
      now: () => now,
    })
    await run(makeTurn(sent, 'hello'))
    expect(specs.length).toBe(1)
    expect(specs[0]!.prompt).not.toContain('<memory_index>')
  })

  test('no seam wired → no memory-index block (default-off behaviour)', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const run = buildLiveAgentTurn({
      substrate: makeStubSubstrate(specs),
      personaLoader: { async load() { return '' } },
      buttonStore: store,
      project_slug: 'alice',
      owner_home: tmp,
      model: 'test-model',
      now: () => now,
    })
    await run(makeTurn(sent, 'hello'))
    expect(specs[0]!.prompt).not.toContain('<memory_index>')
  })
})
