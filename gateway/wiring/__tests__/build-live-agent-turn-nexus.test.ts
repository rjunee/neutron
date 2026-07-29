/**
 * RC3 — the `<agent_nexus>` per-turn injection regression.
 *
 * Mirrors the `<work_board>` per-turn test: because `instance_fragments` is
 * assembled ONLY on the cold first turn (warm turns send bare `turn.user_text`),
 * a fragment-only wiring would re-ground once per session. This locks BOTH paths
 * (cold via instance_fragments, warm via the splice before the user's message),
 * the best-effort degrade on a throwing seam, and the flag-off no-op (no seam
 * wired → no `<agent_nexus>` block).
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
  tmp = mkdtempSync(join(tmpdir(), 'neutron-lat-nx-'))
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

const NEXUS = '<agent_nexus>\nNEXUS-MARKER-XYZ\n</agent_nexus>'

describe('agent-nexus per-turn injection (RC3)', () => {
  test('the nexus block is injected into BOTH the cold AND the warm turn prompt', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    // Distinct snapshot PER CALL so a read-once-and-cache impl (reuse the cold snapshot on
    // every warm turn) is caught: the warm turn must carry the SECOND call's fresh block.
    let nexusCalls = 0
    const run = buildLiveAgentTurn({
      substrate: makeStubSubstrate(specs),
      personaLoader: {
        async load() {
          return ''
        },
      },
      nexusSnapshot: async () => {
        nexusCalls += 1
        return `<agent_nexus>\nNEXUS-MARKER-CALL-${nexusCalls}\n</agent_nexus>`
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
    // The snapshot is re-read EVERY turn (every-turn re-grounding), not read-once-cached.
    expect(nexusCalls).toBe(2)
    // Cold turn → the FIRST call's block, folded into instance_fragments (cacheable prefix).
    expect(specs[0]!.prompt).toContain('NEXUS-MARKER-CALL-1')
    expect(specs[0]!.prompt).toContain('<agent_nexus>')
    // Warm turn → the SECOND (fresh) call's block, spliced BEFORE the user's message.
    // Assert the FRESH marker (not the cached CALL-1) AND the order — a swap to
    // `${user_text}\n\n${nexus}` or a cache would both be caught.
    const warm = specs[1]!.prompt
    expect(warm).toContain('NEXUS-MARKER-CALL-2')
    expect(warm).not.toContain('NEXUS-MARKER-CALL-1')
    expect(warm).toContain('second message')
    expect(warm.indexOf('NEXUS-MARKER-CALL-2')).toBeLessThan(warm.indexOf('second message'))
  })

  test('a null snapshot (empty log) injects no block', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const run = buildLiveAgentTurn({
      substrate: makeStubSubstrate(specs),
      personaLoader: {
        async load() {
          return ''
        },
      },
      nexusSnapshot: async () => null,
      buttonStore: store,
      project_slug: 'alice',
      owner_home: tmp,
      model: 'test-model',
      now: () => now,
    })
    await run(makeTurn(sent, 'hello'))
    expect(specs.length).toBe(1)
    expect(specs[0]!.prompt).not.toContain('<agent_nexus>')
  })

  test('a throwing/rejecting snapshot seam degrades to no block (turn still runs)', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const run = buildLiveAgentTurn({
      substrate: makeStubSubstrate(specs),
      personaLoader: {
        async load() {
          return ''
        },
      },
      nexusSnapshot: async () => {
        throw new Error('nexus read exploded')
      },
      buttonStore: store,
      project_slug: 'alice',
      owner_home: tmp,
      model: 'test-model',
      now: () => now,
    })
    await run(makeTurn(sent, 'hello'))
    expect(specs.length).toBe(1)
    expect(specs[0]!.prompt).not.toContain('<agent_nexus>')
  })

  test('no seam wired (flag off) → no nexus block (unchanged behaviour)', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const run = buildLiveAgentTurn({
      substrate: makeStubSubstrate(specs),
      personaLoader: {
        async load() {
          return ''
        },
      },
      buttonStore: store,
      project_slug: 'alice',
      owner_home: tmp,
      model: 'test-model',
      now: () => now,
    })
    await run(makeTurn(sent, 'hello'))
    expect(specs[0]!.prompt).not.toContain('<agent_nexus>')
  })
})
