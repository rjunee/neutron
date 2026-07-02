/**
 * 2026-07-01 — unit coverage for the ACTIVITY-BASED timeout recovery in
 * `build-live-agent-turn.ts` (the composer half; the substrate's inactivity
 * watchdog is covered in persistent-repl-substrate.test.ts):
 *
 *   • A genuine FREEZE-timeout is AUTO-RETRIED once, silently. If the retry
 *     succeeds the user sees ONLY the answer — no dead-end bubble.
 *   • If the retry ALSO freezes, the user gets the honest `TIMEOUT_BODY` + a
 *     one-click Retry affordance — NEVER the misleading "AI connection may need
 *     attention in settings" text.
 *   • A NON-freeze fault (credentials / cooldown / etc.) is NOT retried and keeps
 *     its own actionable `FAILURE_BODY`.
 *   • Tapping Retry (a turn carrying `RETRY_TURN_VALUE`) recovers the last real
 *     user message for the topic and re-runs on THAT.
 *   • A failed SEED turn stays silent (no retry, no bubble) so a reload re-fires it.
 *
 * Stubbed substrate (no real `claude` spawn); REAL ButtonStore over an on-disk
 * migrated project.db so the Retry-prompt persistence exercises the gateway SQL.
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
import {
  buildLiveAgentTurn,
  RETRY_TURN_VALUE,
  TIMEOUT_BODY,
} from '../build-live-agent-turn.ts'
import type { LiveAgentTurnRequest } from '../../http/chat-bridge.ts'

const TURN_TIMEOUT_ERR = 'cc-llm-call: persistent-repl: turn timeout'

let tmp: string
let db: ProjectDb
let store: ButtonStore
let now = 1_000_000

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-lat-timeout-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  now = 1_000_000
  store = new ButtonStore({ db, now: () => now })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

/**
 * Substrate stub that consumes one scripted outcome per `start()`. Each outcome is
 * either an `error` (yielded as a retryable error event) or a `reply` (token +
 * completion). Records every spec so attempt count is observable.
 */
function makeSeqSubstrate(
  seq: Array<{ error?: string; reply?: string }>,
  specs: AgentSpec[],
): Substrate {
  let i = 0
  return {
    start(spec: AgentSpec): SessionHandle {
      specs.push(spec)
      const outcome = seq[Math.min(i, seq.length - 1)]!
      i += 1
      const events = (async function* (): AsyncGenerator<Event, void, void> {
        if (outcome.error !== undefined) {
          yield { kind: 'error', message: outcome.error, retryable: true }
          return
        }
        yield { kind: 'token', text: outcome.reply ?? 'ok' }
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

function makeRunner(substrate: Substrate) {
  return buildLiveAgentTurn({
    substrate,
    personaLoader: { load: async (): Promise<string> => '' },
    buttonStore: store,
    project_slug: 'alice',
    owner_home: tmp,
    model: 'test-model',
    now: () => now,
  })
}

function makeTurn(over: Partial<LiveAgentTurnRequest> & { sent: ChatOutbound[] }): LiveAgentTurnRequest {
  const { sent, ...rest } = over
  return {
    project_slug: 'alice',
    user_id: 'u-1',
    topic_id: 'web:u-1',
    user_text: 'weave timer+tracker together then do full e2e testing',
    send: (e) => sent.push(e),
    observed_at: now,
    ...rest,
  }
}

describe('build-live-agent-turn — freeze-timeout auto-retry + Retry affordance', () => {
  test('a FREEZE-timeout is auto-retried once; a successful retry delivers the answer with NO dead-end bubble', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    // First dispatch freezes, second succeeds.
    const run = makeRunner(makeSeqSubstrate([{ error: TURN_TIMEOUT_ERR }, { reply: 'Done — all green.' }], specs))
    const result = await run(makeTurn({ sent }))

    expect(result.outcome).toBe('replied')
    // Exactly two dispatches: the frozen one + the silent auto-retry.
    expect(specs).toHaveLength(2)
    const messages = sent.filter((e) => e.type === 'agent_message') as Array<{ body: string }>
    // The user sees ONLY the answer — no timeout / connection bubble.
    expect(messages).toHaveLength(1)
    expect(messages[0]!.body).toBe('Done — all green.')
    expect(messages.some((m) => m.body === TIMEOUT_BODY)).toBe(false)
  })

  test('when the auto-retry ALSO freezes: honest TIMEOUT_BODY + a Retry button, NOT the connection text', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const run = makeRunner(makeSeqSubstrate([{ error: TURN_TIMEOUT_ERR }], specs))
    const result = await run(makeTurn({ sent }))

    expect(result.outcome).toBe('failed')
    // Auto-retried once → two dispatches.
    expect(specs).toHaveLength(2)
    const msg = sent.find((e) => e.type === 'agent_message') as {
      body: string
      options?: ReadonlyArray<{ body: string; value: string }>
      allow_freeform?: boolean
      prompt_id?: string
    }
    expect(msg).toBeDefined()
    // Honest timeout copy — and CRUCIALLY not the misleading credential message.
    expect(msg.body).toBe(TIMEOUT_BODY)
    expect(msg.body).not.toContain('AI connection may need attention')
    // One-click Retry affordance, freeform still open, and a prompt_id (persisted
    // so the web client's button-tap routes).
    expect(msg.options?.map((o) => o.body)).toEqual(['Retry'])
    expect(msg.options?.[0]?.value).toBe(RETRY_TURN_VALUE)
    expect(msg.allow_freeform).toBe(true)
    expect(typeof msg.prompt_id).toBe('string')
  })

  test('a NON-freeze fault is NOT retried and keeps the actionable FAILURE_BODY', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const run = makeRunner(makeSeqSubstrate([{ error: 'cc-llm-call: HTTP 401: invalid api key' }], specs))
    const result = await run(makeTurn({ sent }))

    expect(result.outcome).toBe('failed')
    // No auto-retry for a real fault.
    expect(specs).toHaveLength(1)
    const msg = sent.find((e) => e.type === 'agent_message') as {
      body: string
      options?: ReadonlyArray<{ body: string; value: string }>
    }
    expect(msg.body).toContain('your AI connection may need attention in settings')
    expect(msg.body).not.toBe(TIMEOUT_BODY)
    // No Retry affordance on a credential failure — it keeps its own message.
    expect(msg.options ?? []).toHaveLength(0)
  })

  test('tapping Retry recovers the last real user message and re-runs on it', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    // Turn 1 (the real question) succeeds and records lastUserText; the Retry tap
    // (turn carrying RETRY_TURN_VALUE) must re-run on the recovered question.
    const run = makeRunner(makeSeqSubstrate([{ reply: 'first answer' }, { reply: 'second answer' }], specs))
    const original = 'weave timer+tracker together then do full e2e testing'
    await run(makeTurn({ sent, user_text: original }))

    // A Retry tap arrives as a fresh turn carrying the sentinel value.
    const result = await run(makeTurn({ sent, user_text: RETRY_TURN_VALUE }))
    expect(result.outcome).toBe('replied')
    // The SECOND dispatch's prompt carries the recovered original text, not the sentinel.
    expect(specs).toHaveLength(2)
    expect(specs[1]!.prompt).toContain(original)
    expect(specs[1]!.prompt).not.toContain(RETRY_TURN_VALUE)
  })

  test('a Retry tap with no recorded message falls back to a gentle re-prompt (never echoes the sentinel)', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const run = makeRunner(makeSeqSubstrate([{ reply: 'ok' }], specs))
    // No prior turn on this topic → nothing recorded.
    const result = await run(makeTurn({ sent, topic_id: 'web:u-1:ghost', project_id: 'ghost', user_text: RETRY_TURN_VALUE }))
    expect(result.outcome).toBe('replied')
    expect(specs[0]!.prompt).not.toContain(RETRY_TURN_VALUE)
    expect(specs[0]!.prompt).toContain('Please try my previous message again.')
  })

  test('a failed SEED freeze stays silent — no retry, no bubble (reload re-fires)', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const run = makeRunner(makeSeqSubstrate([{ error: TURN_TIMEOUT_ERR }], specs))
    const result = await run(makeTurn({ sent, seed_turn: true }))
    expect(result.outcome).toBe('failed')
    // Seed turns are never retried and never bubble.
    expect(specs).toHaveLength(1)
    expect(sent.filter((e) => e.type === 'agent_message')).toHaveLength(0)
  })
})
