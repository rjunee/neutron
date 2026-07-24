/**
 * build-live-agent-turn-auth-reconnect.test.ts — the 2026-07-24 auth-failure UX.
 *
 * When a turn fails because the underlying Claude connection reported an invalid /
 * expired credential (the substrate abandons it with the `auth_invalid` class +
 * the `auth token invalid — reconnect required` message), the owner must get the
 * ACTIONABLE reconnect bubble (`AUTH_RECONNECT_BODY`) — NOT the useless freeze-
 * timeout "tap Retry" and NOT the generic credential `FAILURE_BODY`.
 *
 * Stubbed substrate (no real `claude` spawn); REAL ButtonStore over an on-disk
 * migrated project.db so the reconnect-bubble persistence exercises the gateway SQL.
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
import {
  AUTH_RECONNECT_BODY,
  buildLiveAgentTurn,
  isAuthInvalid,
  isFreezeTimeout,
  TIMEOUT_BODY,
} from '../build-live-agent-turn.ts'
import type { LiveAgentTurnRequest } from '../../http/chat-bridge.ts'

/** The message the substrate's `failAuthInvalid` (pool.ts) surfaces, as the caller
 *  sees it after `collectTokensToString` prefixes `cc-llm-call: `. */
const AUTH_ERR = 'cc-llm-call: persistent-repl: auth token invalid — reconnect required'
const TURN_TIMEOUT_ERR = 'cc-llm-call: persistent-repl: turn timeout'

let tmp: string
let db: ProjectDb
let store: ButtonStore
let now = 1_000_000

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-auth-reconnect-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  now = 1_000_000
  store = new ButtonStore({ db, now: () => now })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function makeSeqSubstrate(seq: Array<{ error?: string; reply?: string }>, specs: AgentSpec[]): Substrate {
  let i = 0
  return {
    start(spec: AgentSpec): SessionHandle {
      specs.push(spec)
      const outcome = seq[Math.min(i, seq.length - 1)]!
      i += 1
      const events = (async function* (): AsyncGenerator<Event, void, void> {
        if (outcome.error !== undefined) {
          yield { kind: 'error', message: outcome.error, retryable: false }
          return
        }
        yield { kind: 'token', text: outcome.reply ?? 'ok' }
        yield { kind: 'completion', usage: { input_tokens: 1, output_tokens: 1 }, substrate_instance_id: 'stub' }
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
    user_text: 'what is the veeva narrative?',
    send: (e) => sent.push(e),
    observed_at: now,
    ...rest,
  }
}

describe('build-live-agent-turn — auth-invalid reconnect bubble', () => {
  test('isAuthInvalid / isFreezeTimeout classify the auth message distinctly', () => {
    expect(isAuthInvalid(AUTH_ERR)).toBe(true)
    // Crucially it must NOT also read as a freeze-timeout (which would steal the
    // classification and ship the wrong bubble).
    expect(isFreezeTimeout(AUTH_ERR)).toBe(false)
    expect(isAuthInvalid(TURN_TIMEOUT_ERR)).toBe(false)
  })

  test('an auth-invalid failure ships the reconnect bubble, NOT retry/timeout/failure text', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const run = makeRunner(makeSeqSubstrate([{ error: AUTH_ERR }], specs))
    const result = await run(makeTurn({ sent }))

    expect(result.outcome).toBe('failed')
    // NOT auto-retried — retrying an invalid token is pointless.
    expect(specs).toHaveLength(1)
    const msg = sent.find((e) => e.type === 'agent_message') as {
      body: string
      options?: ReadonlyArray<unknown>
      allow_freeform?: boolean
      prompt_id?: string
    }
    expect(msg).toBeDefined()
    expect(msg.body).toBe(AUTH_RECONNECT_BODY)
    expect(msg.body).toContain('claude setup-token')
    expect(msg.body).not.toBe(TIMEOUT_BODY)
    expect(msg.body).not.toContain('AI connection may need attention')
    // No Retry button (a re-run would just hit the same invalid token); freeform
    // stays open so the owner can send again after reconnecting.
    expect(msg.options ?? []).toHaveLength(0)
    expect(msg.allow_freeform).toBe(true)
    // Persisted as durable history so a reload re-hydrates the actionable message.
    expect(typeof msg.prompt_id).toBe('string')
  })

  test('a failed SEED turn on auth-invalid stays silent (reload re-fires)', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const run = makeRunner(makeSeqSubstrate([{ error: AUTH_ERR }], specs))
    const result = await run(makeTurn({ sent, seed_turn: true }))
    expect(result.outcome).toBe('failed')
    expect(sent.filter((e) => e.type === 'agent_message')).toHaveLength(0)
  })
})
