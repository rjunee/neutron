/**
 * Go-live race (2026-06-20, owner dogfood — General live-agent chat).
 *
 * Owner asked two questions in General in quick succession:
 *   Q1 "are any reminders currently set?"
 *   Q2 "and what overnight work is currently scheduled?"
 * Observed: "Waking up your workspace for the first time…" appeared MULTIPLE
 * times, the reminders answer rendered TWICE, and the overnight question was
 * NEVER answered. Server log showed TWO `live_agent_turn` events both
 * COLD-started → two parallel cold sessions racing for the same (instance,
 * topic).
 *
 * ROOT CAUSE: `runLiveAgentTurn` has no per-(instance, topic) serialization.
 * `contextSent.add(topicKey)` only runs AFTER a turn's dispatch settles, so a
 * 2nd turn that arrives before the 1st settles ALSO sees `isColdFirstTurn`,
 * ALSO arms the cold-start ack, and ALSO composes the heavy first-turn context
 * prompt → two parallel cold dispatches, duplicate acks, replies race, one
 * question lost.
 *
 * This test fires two turns on the SAME (instance, topic) nearly
 * simultaneously (2nd before the 1st settles) and asserts the serialized,
 * correct behaviour:
 *   - exactly ONE "Waking up" ack
 *   - exactly ONE cold first-turn dispatch (single warm session; the 2nd turn
 *     reuses it → its dispatch carries only the bare user text)
 *   - TWO distinct, in-order replies (Q1 → Q2), no duplicate, no dropped turn
 *
 * RED on the pre-fix code (two cold dispatches, two acks, racing replies);
 * GREEN once turns are serialized per (instance, topic).
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

let tmp: string
let db: ProjectDb
let store: ButtonStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-lat-overlap-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  store = new ButtonStore({ db })
})
afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

/** Marker the first-turn composer appends right before the user's text. A
 *  dispatch whose prompt contains it is a COLD first turn (heavy persona +
 *  `<live_agent_context>` scaffold); a warm turn's prompt is the bare text. */
const COLD_PROMPT_MARKER = "The user's message follows. Reply to it directly."

/** Extract the user's question from a dispatched prompt — the tail after the
 *  cold marker for a first turn, or the whole prompt for a warm turn. Lets the
 *  stub echo an identifiable reply so we can map replies → questions. */
function extractUserText(prompt: string): string {
  const i = prompt.lastIndexOf(COLD_PROMPT_MARKER)
  if (i < 0) return prompt.trim()
  return prompt.slice(i + COLD_PROMPT_MARKER.length).trim()
}

interface Dispatch {
  prompt: string
  cold: boolean
  question: string
}

/**
 * Substrate that records every dispatch (so the test can count cold spawns +
 * verify per-question replies) and answers after `delay_ms` (simulates the
 * cold-spawn latency window that opens the overlapping-turn race). Each reply
 * echoes the question it answered so replies are distinct + mappable.
 */
function makeRecordingSubstrate(delay_ms: number): {
  substrate: Substrate
  dispatches: Dispatch[]
} {
  const dispatches: Dispatch[] = []
  const substrate: Substrate = {
    start(spec: AgentSpec): SessionHandle {
      const prompt = spec.prompt
      const question = extractUserText(prompt)
      dispatches.push({ prompt, cold: prompt.includes(COLD_PROMPT_MARKER), question })
      const reply = `ANSWER[${question}]`
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
  return { substrate, dispatches }
}

const Q1 = 'are any reminders currently set?'
const Q2 = 'and what overnight work is currently scheduled?'

describe('build-live-agent-turn — overlapping-turn serialization (go-live race)', () => {
  test('two rapid same-topic turns: ONE ack, ONE cold spawn, TWO in-order replies', async () => {
    const sent: ChatOutbound[] = []
    const send = (e: ChatOutbound): void => {
      sent.push(e)
    }
    // Slow enough that the 2nd turn arrives well inside the 1st's cold window.
    const { substrate, dispatches } = makeRecordingSubstrate(60)
    const run = buildLiveAgentTurn({
      substrate,
      personaLoader: {
        async load(): Promise<string> {
          return ''
        },
      },
      buttonStore: store,
      project_slug: 'owner',
      owner_home: tmp,
      model: 'test-model',
      ack_delay_ms: 5, // fires during the cold dispatch
    })

    // Fire BOTH turns on the SAME topic without awaiting the first — the 2nd
    // lands before the 1st has settled (the exact owner dogfood sequence).
    const base = {
      project_slug: 'owner',
      user_id: 'u-1',
      topic_id: 'web:u-1',
      send,
      observed_at: 0,
    }
    const p1 = run({ ...base, user_text: Q1 })
    const p2 = run({ ...base, user_text: Q2 })
    const [r1, r2] = await Promise.all([p1, p2])

    // Both turns succeeded.
    expect(r1.outcome).toBe('replied')
    expect(r2.outcome).toBe('replied')

    const agentMsgs = sent.filter((e) => e.type === 'agent_message') as Array<{
      body: string
      prompt_id?: string
    }>
    const acks = agentMsgs.filter((m) => m.body.includes('Waking up'))
    const replies = agentMsgs.filter((m) => !m.body.includes('Waking up'))

    // Exactly ONE "waking up" ack — fires once per (instance, topic) warm-up,
    // not once per racing turn.
    expect(acks).toHaveLength(1)

    // Exactly ONE cold first-turn dispatch: the 1st turn establishes the warm
    // session, the 2nd reuses it (bare user text, no persona re-send).
    expect(dispatches).toHaveLength(2)
    expect(dispatches.filter((d) => d.cold)).toHaveLength(1)

    // TWO distinct, in-order replies — Q1 then Q2, each exactly once.
    expect(replies).toHaveLength(2)
    expect(replies[0]!.body).toBe(`ANSWER[${Q1}]`)
    expect(replies[1]!.body).toBe(`ANSWER[${Q2}]`)
    // No duplicate (the go-live symptom was the reminders answer rendered TWICE).
    expect(new Set(replies.map((r) => r.body)).size).toBe(2)
    // Both questions actually reached the substrate, in order.
    expect(dispatches.map((d) => d.question)).toEqual([Q1, Q2])
  })
})
