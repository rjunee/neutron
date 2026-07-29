/**
 * Plan task 8 — the runner side of the deterministic ritual-approval capture in
 * `build-live-agent-turn.ts`.
 *
 * Asserts:
 *   (a) with `ritualApprovalCapture` wired + a persisted prior prompt carrying an
 *       `rap:` option, an EXACT-match user_text invokes the capture with the
 *       PERSISTED option values, ships the deterministic confirmation via `send`,
 *       persists an inert row, and NEVER dispatches the substrate turn.
 *   (b) an unrelated reply → capture returns null → the NORMAL turn dispatches.
 *
 * Stubbed substrate (no real `claude`); REAL ButtonStore over a migrated
 * project.db (the capture test precedent).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ButtonStore } from '@neutronai/channels/button-store.ts'
import { buildButtonPrompt } from '@neutronai/channels/button-primitive.ts'
import type { ChatOutbound } from '@neutronai/landing/server.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import { buildLiveAgentTurn } from '../build-live-agent-turn.ts'
import type { LiveAgentTurnRequest } from '../../http/chat-bridge.ts'

const RAP_VALUE = `rap:${'A'.repeat(22)}:a`

let tmp: string
let db: ProjectDb
let store: ButtonStore
let now = 2_000_000

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-lat-rap-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  now = 2_000_000
  store = new ButtonStore({ db, now: () => now })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function makeStubSubstrate(reply: string, specs: AgentSpec[]): Substrate {
  return {
    start(spec: AgentSpec): SessionHandle {
      specs.push(spec)
      const events = (async function* (): AsyncGenerator<Event, void, void> {
        yield { kind: 'token', text: reply }
        yield {
          kind: 'completion',
          usage: { input_tokens: 1, output_tokens: 1 },
          substrate_instance_id: 'stub',
        }
      })()
      return {
        events,
        async respondToTool(): Promise<void> {
          throw new Error('not used')
        },
        async cancel(): Promise<void> {},
        tool_resolution: 'internal',
      }
    },
  }
}

interface CaptureProbe {
  fn: (input: {
    user_id: string
    user_text: string
    topic_id: string
    prior_option_values: readonly string[]
  }) => Promise<{ body: string } | null>
  calls: Array<{ user_text: string; prior_option_values: readonly string[] }>
}

function makeCapture(reply: { body: string } | null): CaptureProbe {
  const calls: CaptureProbe['calls'] = []
  return {
    calls,
    fn: async (input) => {
      calls.push({ user_text: input.user_text, prior_option_values: input.prior_option_values })
      // deterministic: only the exact rap: token resolves; anything else is null
      return input.user_text.trim() === RAP_VALUE ? reply : null
    },
  }
}

function makeRunner(reply: string, capture: CaptureProbe['fn'], specs: AgentSpec[]) {
  return buildLiveAgentTurn({
    substrate: makeStubSubstrate(reply, specs),
    personaLoader: { load: async (): Promise<string> => '' },
    buttonStore: store,
    ritualApprovalCapture: capture,
    project_slug: 'alice',
    owner_home: tmp,
    model: 'test-model',
    now: () => now,
  })
}

function makeTurn(sent: ChatOutbound[], over?: Partial<LiveAgentTurnRequest>): LiveAgentTurnRequest {
  return {
    project_slug: 'alice',
    user_id: 'u-1',
    topic_id: 'app:u-1',
    user_text: RAP_VALUE,
    send: (e) => sent.push(e),
    observed_at: now,
    ...over,
  }
}

/** Persist a prior agent prompt carrying the rap: approval option. */
async function seedApprovalPrompt(): Promise<void> {
  const prompt = buildButtonPrompt({
    body: 'Ritual approval needed: daily-digest',
    options: [
      { label: 'Approve', body: 'Approve this ritual', value: RAP_VALUE },
      { label: 'Deny', body: 'Deny this ritual', value: `rap:${'A'.repeat(22)}:d` },
    ],
    allow_freeform: true,
    expires_in_ms: 10_000,
    uuid: randomUUID,
  })
  await store.emit(prompt, { topic_id: 'app:u-1' })
}

describe('build-live-agent-turn — ritual approval capture (task 8)', () => {
  test('exact rap: token → capture invoked with persisted options, deterministic reply, NO dispatch', async () => {
    await seedApprovalPrompt()
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const probe = makeCapture({ body: 'Approved and scheduled: "daily-digest" will run about once a week.' })
    const run = makeRunner('LLM SHOULD NOT RUN', probe.fn, specs)

    const result = await run(makeTurn(sent, { user_text: RAP_VALUE }))

    // capture ran with the PERSISTED option values
    expect(probe.calls).toHaveLength(1)
    expect(probe.calls[0]!.prior_option_values).toContain(RAP_VALUE)
    // deterministic confirmation shipped
    const agentMsgs = sent.filter((e) => e.type === 'agent_message')
    expect(agentMsgs).toHaveLength(1)
    expect((agentMsgs[0] as { body: string }).body).toContain('Approved and scheduled')
    // the LLM turn was NEVER dispatched
    expect(specs).toHaveLength(0)
    expect(result.outcome).toBe('replied')
    expect(result.reply_prompt_id).toBeNull()
    // an inert confirmation row is in history
    const { turns } = await store.listHistoryByTopic({
      topic_id: 'app:u-1',
      before: now + 1,
      before_prompt_id: null,
      limit: 20,
      now: now + 1,
    })
    expect(turns.some((t) => t.body.includes('Approved and scheduled'))).toBe(true)
  })

  test('an unrelated reply → capture returns null → the NORMAL turn dispatches', async () => {
    await seedApprovalPrompt()
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const probe = makeCapture({ body: 'unused' })
    const run = makeRunner('Here is my normal reply.', probe.fn, specs)

    const result = await run(makeTurn(sent, { user_text: 'what is the weather like' }))

    // capture consulted but declined
    expect(probe.calls).toHaveLength(1)
    // the NORMAL turn dispatched
    expect(specs).toHaveLength(1)
    expect(sent.some((e) => e.type === 'agent_message')).toBe(true)
    expect(result.outcome).toBe('replied')
  })

  test('a seed turn never triggers the capture', async () => {
    await seedApprovalPrompt()
    const specs: AgentSpec[] = []
    const probe = makeCapture({ body: 'unused' })
    const run = makeRunner('opener', probe.fn, specs)
    await run(makeTurn([], { seed_turn: true, user_text: '(system: greet)' }))
    expect(probe.calls).toHaveLength(0)
    expect(specs).toHaveLength(1) // seed still dispatches
  })
})
