/**
 * WAVE 2 P1 (gap-audit §(c) #10) — the reflection + learning layer wiring into
 * the live-agent turn. Asserts the read path (loadContext spliced into the
 * FIRST-turn prompt) and the write path (onTurnComplete fired after each reply
 * with the right exchange + scope). Stubbed substrate + REAL ButtonStore over a
 * migrated db, mirroring build-live-agent-turn.test.ts.
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
import { buildLiveAgentTurn, type LiveAgentReflectionSeam } from '../build-live-agent-turn.ts'
import type { LiveAgentTurnRequest } from '../../http/chat-bridge.ts'

let tmp: string
let db: ProjectDb
let store: ButtonStore
let now = 1_000_000

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-lat-reflection-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  now = 1_000_000
  store = new ButtonStore({ db, now: () => now })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function makeStubSubstrate(specs: AgentSpec[], reply = 'ok reply'): Substrate {
  return {
    start(spec: AgentSpec): SessionHandle {
      specs.push(spec)
      const events = (async function* (): AsyncGenerator<Event, void, void> {
        yield { kind: 'token', text: reply }
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

function makeTurn(over: Partial<LiveAgentTurnRequest> & { sent: ChatOutbound[] }): LiveAgentTurnRequest {
  const { sent, ...rest } = over
  return {
    project_slug: 'alice',
    user_id: 'u-1',
    topic_id: 'web:u-1',
    user_text: 'no, do not deploy to prod',
    send: (e) => sent.push(e),
    observed_at: now,
    ...rest,
  }
}

describe('build-live-agent-turn — reflection wiring', () => {
  test('splices loadContext() into the FIRST-turn prompt and fires onTurnComplete', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const completed: Array<{ user_text: string; agent_text: string; scope?: string }> = []
    const reflection: LiveAgentReflectionSeam = {
      loadContext: () =>
        '<learned_corrections>\n- always default to staging\n</learned_corrections>',
      onTurnComplete: (t) => completed.push(t),
    }
    const run = buildLiveAgentTurn({
      substrate: makeStubSubstrate(specs, 'I deployed to prod.'),
      personaLoader: { async load(): Promise<string> { return 'PERSONA' } },
      reflection,
      buttonStore: store,
      project_slug: 'alice',
      owner_home: tmp,
      now: () => now,
    })

    await run(makeTurn({ sent }))

    // Read path: the learned-corrections block is in the first-turn prompt.
    expect(specs).toHaveLength(1)
    expect(specs[0]!.prompt).toContain('always default to staging')

    // Write path: the hook fired with this exchange + the General scope.
    expect(completed).toHaveLength(1)
    expect(completed[0]!.user_text).toBe('no, do not deploy to prod')
    expect(completed[0]!.agent_text).toBe('I deployed to prod.')
    expect(completed[0]!.scope).toBe('general')
  })

  test('passes the project id as scope for a project topic', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const completed: Array<{ scope?: string }> = []
    const reflection: LiveAgentReflectionSeam = {
      loadContext: () => null,
      onTurnComplete: (t) => completed.push(t),
    }
    const run = buildLiveAgentTurn({
      substrate: makeStubSubstrate(specs),
      personaLoader: { async load(): Promise<string> { return 'PERSONA' } },
      reflection,
      buttonStore: store,
      project_slug: 'alice',
      owner_home: tmp,
      now: () => now,
    })
    await run(makeTurn({ sent, project_id: 'globex', topic_id: 'web:globex' }))
    expect(completed[0]!.scope).toBe('globex')
  })

  test('a null loadContext() injects no block but the turn still replies', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const reflection: LiveAgentReflectionSeam = {
      loadContext: () => null,
      onTurnComplete: () => {},
    }
    const run = buildLiveAgentTurn({
      substrate: makeStubSubstrate(specs),
      personaLoader: { async load(): Promise<string> { return 'PERSONA' } },
      reflection,
      buttonStore: store,
      project_slug: 'alice',
      owner_home: tmp,
      now: () => now,
    })
    const result = await run(makeTurn({ sent }))
    expect(result.outcome).toBe('replied')
    expect(specs[0]!.prompt).not.toContain('learned_corrections')
  })

  test('a throwing reflection seam never breaks the reply', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const reflection: LiveAgentReflectionSeam = {
      loadContext: () => {
        throw new Error('context boom')
      },
      onTurnComplete: () => {
        throw new Error('hook boom')
      },
    }
    const run = buildLiveAgentTurn({
      substrate: makeStubSubstrate(specs),
      personaLoader: { async load(): Promise<string> { return 'PERSONA' } },
      reflection,
      buttonStore: store,
      project_slug: 'alice',
      owner_home: tmp,
      now: () => now,
    })
    const result = await run(makeTurn({ sent }))
    expect(result.outcome).toBe('replied')
  })
})
