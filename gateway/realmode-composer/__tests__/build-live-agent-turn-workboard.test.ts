/**
 * Work Board (Phase 1a) — the per-turn injection regression.
 *
 * The brief asks the board be injected into EVERY orchestrator turn. Because
 * `instance_fragments` is assembled ONLY on the cold first turn (warm turns
 * send bare `turn.user_text`), a fragment-only wiring would re-ground once per
 * session. This test locks BOTH paths: the `<work_board>` block must appear in
 * the cold-turn prompt (via instance_fragments) AND the warm-turn prompt (via
 * the splice before the user's message).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { ButtonStore } from '../../../channels/button-store.ts'
import type { ChatOutbound } from '../../../landing/server.ts'
import type { Event } from '../../../runtime/events.ts'
import type { AgentSpec, Substrate } from '../../../runtime/substrate.ts'
import type { SessionHandle } from '../../../runtime/session-handle.ts'
import { buildLiveAgentTurn } from '../build-live-agent-turn.ts'
import type { LiveAgentTurnRequest } from '../../http/chat-bridge.ts'

let tmp: string
let db: ProjectDb
let store: ButtonStore
const now = 1_000_000

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-lat-wb-'))
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
        yield { kind: 'completion', usage: { input_tokens: 1, output_tokens: 1 }, substrate_instance_id: 'stub' }
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

const BOARD = '<work_board>\nBOARD-MARKER-XYZ\n</work_board>'

describe('Work Board per-turn injection', () => {
  test('the board is injected into BOTH the cold AND the warm turn prompt', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const run = buildLiveAgentTurn({
      substrate: makeStubSubstrate(specs),
      personaLoader: { async load() { return '' } },
      workBoardSnapshot: () => BOARD,
      buttonStore: store,
      project_slug: 'alice',
      owner_home: tmp,
      model: 'test-model',
      now: () => now,
    })

    await run(makeTurn(sent, 'first message')) // cold
    await run(makeTurn(sent, 'second message')) // warm

    expect(specs.length).toBe(2)
    // Cold turn → folded into instance_fragments (the cacheable system prefix).
    expect(specs[0]!.prompt).toContain('BOARD-MARKER-XYZ')
    expect(specs[0]!.prompt).toContain('<work_board>')
    // Warm turn → spliced before the user's message (every-turn re-grounding).
    expect(specs[1]!.prompt).toContain('BOARD-MARKER-XYZ')
    expect(specs[1]!.prompt).toContain('second message')
  })

  test('a throwing snapshot seam degrades to no block (turn still runs)', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const run = buildLiveAgentTurn({
      substrate: makeStubSubstrate(specs),
      personaLoader: { async load() { return '' } },
      workBoardSnapshot: () => {
        throw new Error('board read exploded')
      },
      buttonStore: store,
      project_slug: 'alice',
      owner_home: tmp,
      model: 'test-model',
      now: () => now,
    })
    await run(makeTurn(sent, 'hello'))
    expect(specs.length).toBe(1)
    expect(specs[0]!.prompt).not.toContain('<work_board>')
  })

  test('no seam wired → no board block (unchanged behaviour)', async () => {
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
    expect(specs[0]!.prompt).not.toContain('<work_board>')
  })
})
