/**
 * Item 12 (2026-06-19, owner live-dogfood) — cold-start ack.
 *
 * The first turn into a project's chat pays a one-time CC cold-spawn
 * (~100s observed). The owner saw only a typing indicator "with nothing
 * happening" and assumed it was hung. The runner now arms a delayed
 * "waking up" bubble that fires iff the dispatch is still running after
 * `ack_delay_ms`, and is cancelled by a fast/warm reply.
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

let tmp: string
let db: ProjectDb
let store: ButtonStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-lat-cold-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  store = new ButtonStore({ db })
})
afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

/** Substrate whose reply is delayed `delay_ms` (simulates a cold spawn). */
function makeSlowSubstrate(reply: string, delay_ms: number): Substrate {
  return {
    start(_spec: AgentSpec): SessionHandle {
      const events = (async function* (): AsyncGenerator<Event, void, void> {
        await new Promise((r) => setTimeout(r, delay_ms))
        yield { kind: 'token', text: reply }
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

function makeRunner(substrate: Substrate, ack_delay_ms: number) {
  return buildLiveAgentTurn({
    substrate,
    personaLoader: { async load(): Promise<string> { return '' } },
    buttonStore: store,
    project_slug: 'alice',
    owner_home: tmp,
    model: 'test-model',
    ack_delay_ms,
  })
}

describe('build-live-agent-turn — cold-start ack (Item 12)', () => {
  test('slow cold first turn emits the waking-up ack BEFORE the reply', async () => {
    const sent: ChatOutbound[] = []
    // ack_delay 10ms; reply delayed 60ms → the ack fires first.
    const run = makeRunner(makeSlowSubstrate('Here is your answer.', 60), 10)
    const res = await run({
      project_slug: 'alice',
      user_id: 'u-1',
      topic_id: 'web:u-1',
      user_text: 'what is open in Globex?',
      send: (e) => sent.push(e),
      observed_at: 0,
    })
    expect(res.outcome).toBe('replied')
    const msgs = sent.filter((e) => e.type === 'agent_message') as Array<{
      body: string
      prompt_id?: string
    }>
    // Two bubbles: the ack (no prompt_id) then the real reply (with prompt_id).
    expect(msgs).toHaveLength(2)
    expect(msgs[0]!.body).toContain('Waking up')
    expect(msgs[0]!.prompt_id).toBeUndefined()
    expect(msgs[1]!.body).toBe('Here is your answer.')
    expect(msgs[1]!.prompt_id).toBe(res.reply_prompt_id!)
  })

  test('fast turn does NOT ack (timer cancelled before firing)', async () => {
    const sent: ChatOutbound[] = []
    // ack_delay 200ms; reply delayed 0ms → cleared before firing.
    const run = makeRunner(makeSlowSubstrate('Fast answer.', 0), 200)
    await run({
      project_slug: 'alice',
      user_id: 'u-1',
      topic_id: 'web:u-1',
      user_text: 'hi',
      send: (e) => sent.push(e),
      observed_at: 0,
    })
    const msgs = sent.filter((e) => e.type === 'agent_message')
    expect(msgs).toHaveLength(1)
    expect((msgs[0] as { body: string }).body).toBe('Fast answer.')
  })

  test('second (warm) turn never acks even when slow', async () => {
    const sent: ChatOutbound[] = []
    // Both turns slow; only the FIRST is a cold first-turn → only it could ack.
    const run = makeRunner(makeSlowSubstrate('Answer.', 40), 5)
    await run({
      project_slug: 'alice', user_id: 'u-1', topic_id: 'web:u-1',
      user_text: 'first', send: (e) => sent.push(e), observed_at: 0,
    })
    const afterFirst = sent.filter((e) => e.type === 'agent_message').length
    sent.length = 0
    await run({
      project_slug: 'alice', user_id: 'u-1', topic_id: 'web:u-1',
      user_text: 'second', send: (e) => sent.push(e), observed_at: 0,
    })
    const secondMsgs = sent.filter((e) => e.type === 'agent_message')
    // First turn acked (2 msgs); second turn is warm → reply only, no ack.
    expect(afterFirst).toBe(2)
    expect(secondMsgs).toHaveLength(1)
  })
})
