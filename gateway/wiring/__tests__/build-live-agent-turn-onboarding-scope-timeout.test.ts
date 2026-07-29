/**
 * 2026-06-30 — unit coverage for two onboarding-robustness fixes in
 * `build-live-agent-turn.ts`:
 *
 *  FIX 1 (per-project opening was a generic name-re-ask intro): onboarding is a
 *  GENERAL-TOPIC-ONLY mode. A turn carrying a `project_id` (a materialized
 *  project topic) must NEVER run the interview — no preamble spliced, no
 *  `[[OPTIONS]]` buttons parsed — even while `isActive(user)` still reads true,
 *  so the project topic shows its deterministic opening instead of the agent
 *  improvising "…what should I call you?".
 *
 *  FIX 2 (2026-07-01 activity-based timeout): the per-turn budget is no longer a
 *  fixed wall clock. Every turn carries an INACTIVITY window (`spec.turn_timeout_ms`
 *  — larger for a COLD/onboarding turn, snappy for warm) + an ABSOLUTE-CEILING
 *  backstop (`spec.turn_absolute_ceiling_ms`); the substrate abandons a turn only
 *  after the idle window with NO PTY activity, so a long-but-active turn is never
 *  killed on a clock. A FAILED `seed_turn` stays silent (no bubble) so a reload can
 *  re-fire it; a failed real user turn gets a bubble (a plain fault → the
 *  anti-silence FAILURE_BODY; a freeze-timeout → TIMEOUT_BODY + Retry, covered in
 *  build-live-agent-turn-timeout-retry.test.ts).
 *
 * Stubbed substrate (no real `claude` spawn); REAL ButtonStore over an on-disk
 * migrated project.db.
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
  buildLiveAgentTurn,
  type LiveAgentOnboardingSeam,
} from '../build-live-agent-turn.ts'
import type { LiveAgentTurnRequest } from '../../http/chat-bridge.ts'

// Mirrors the production constants (build-live-agent-turn.ts): the activity-based
// inactivity windows + the absolute-ceiling backstop.
const TURN_INACTIVITY_MS = 90_000
const COLD_TURN_INACTIVITY_MS = 180_000
const TURN_ABSOLUTE_CEILING_MS = 45 * 60_000

let tmp: string
let db: ProjectDb
let store: ButtonStore
let now = 1_000_000

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-lat-scope-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  now = 1_000_000
  store = new ButtonStore({ db, now: () => now })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

/** Records every spec; replies with `reply`, or errors when `error` is set. */
function makeStubSubstrate(opts: {
  reply?: string
  error?: string
  specs: AgentSpec[]
}): Substrate {
  return {
    start(spec: AgentSpec): SessionHandle {
      opts.specs.push(spec)
      const events = (async function* (): AsyncGenerator<Event, void, void> {
        if (opts.error !== undefined) {
          yield { kind: 'error', message: opts.error, retryable: true }
          return
        }
        yield { kind: 'token', text: opts.reply ?? 'stub reply' }
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

const ONBOARDING_PREAMBLE = '<onboarding>PREAMBLE_SENTINEL</onboarding>'

function makeOnboardingSeam(active: boolean): LiveAgentOnboardingSeam {
  return {
    isActive: async (): Promise<boolean> => active,
    systemPreamble: (): string => ONBOARDING_PREAMBLE,
    uploadAffordance: (): { source: 'chatgpt' | 'claude' } | null => null,
    onTurnComplete: (): void => {},
  }
}

function makeRunner(opts: {
  substrate: Substrate
  onboarding?: boolean
}) {
  return buildLiveAgentTurn({
    substrate: opts.substrate,
    personaLoader: { load: async (): Promise<string> => '' },
    buttonStore: store,
    ...(opts.onboarding !== undefined
      ? { onboarding: makeOnboardingSeam(opts.onboarding) }
      : {}),
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
    topic_id: 'app:u-1',
    user_text: 'hello',
    send: (e) => sent.push(e),
    observed_at: now,
    ...rest,
  }
}

describe('FIX 1 — onboarding is General-topic-only', () => {
  const choiceReply =
    'Whose voice should I take on?\n\n[[OPTIONS]]\n- Marcus Aurelius\n- Hermione Granger\n[[/OPTIONS]]'

  test('GENERAL topic (no project_id) WITH onboarding active splices the preamble + parses options', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const run = makeRunner({ substrate: makeStubSubstrate({ reply: choiceReply, specs }), onboarding: true })
    const result = await run(makeTurn({ sent, topic_id: 'app:u-1' }))
    expect(result.outcome).toBe('replied')
    // The first-turn system prompt carries the onboarding preamble.
    expect(specs[0]!.prompt).toContain('PREAMBLE_SENTINEL')
    // And the `[[OPTIONS]]` block is parsed into buttons on a General onboarding turn.
    const reply = sent.find((e) => e.type === 'agent_message') as { options?: ReadonlyArray<{ value: string }> }
    expect(reply.options?.map((o) => o.value)).toEqual(['Marcus Aurelius', 'Hermione Granger'])
  })

  test('PROJECT topic (project_id set) is steady-state EVEN while onboarding active — no preamble, no buttons', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const run = makeRunner({ substrate: makeStubSubstrate({ reply: choiceReply, specs }), onboarding: true })
    const result = await run(
      makeTurn({ sent, topic_id: 'app:u-1:globex', project_id: 'globex' }),
    )
    expect(result.outcome).toBe('replied')
    // No onboarding preamble on a project topic — it is an established project.
    expect(specs[0]!.prompt).not.toContain('PREAMBLE_SENTINEL')
    // The sentinel is NOT parsed into buttons — the raw block stays in the body.
    const reply = sent.find((e) => e.type === 'agent_message') as {
      body: string
      options?: ReadonlyArray<unknown>
    }
    expect(reply.options ?? []).toHaveLength(0)
    expect(reply.body).toContain('[[OPTIONS]]')
  })
})

describe('FIX 2 — activity-based per-turn budgets', () => {
  test('a COLD first turn carries the larger inactivity window + the absolute ceiling', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const run = makeRunner({ substrate: makeStubSubstrate({ reply: 'ok', specs }) })
    await run(makeTurn({ sent }))
    expect(specs[0]!.turn_timeout_ms).toBe(COLD_TURN_INACTIVITY_MS)
    expect(specs[0]!.turn_absolute_ceiling_ms).toBe(TURN_ABSOLUTE_CEILING_MS)
  })

  test('an ONBOARDING turn keeps the larger inactivity window even when warm', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const run = makeRunner({ substrate: makeStubSubstrate({ reply: 'ok', specs }), onboarding: true })
    // First (cold) turn, then a second (warm) turn on the SAME topic.
    await run(makeTurn({ sent }))
    await run(makeTurn({ sent }))
    // The warm onboarding turn STILL carries the larger idle window (onboarding load).
    expect(specs[1]!.turn_timeout_ms).toBe(COLD_TURN_INACTIVITY_MS)
  })

  test('a WARM steady-state turn drops to the snappy inactivity window (ceiling unchanged)', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const run = makeRunner({ substrate: makeStubSubstrate({ reply: 'ok', specs }) })
    await run(makeTurn({ sent })) // cold
    await run(makeTurn({ sent })) // warm
    expect(specs[0]!.turn_timeout_ms).toBe(COLD_TURN_INACTIVITY_MS)
    expect(specs[1]!.turn_timeout_ms).toBe(TURN_INACTIVITY_MS)
    // The absolute-ceiling backstop is on EVERY turn — a long-but-active turn is
    // bounded only by this, never by the (activity-reset) idle window.
    expect(specs[1]!.turn_absolute_ceiling_ms).toBe(TURN_ABSOLUTE_CEILING_MS)
  })
})

describe('FIX 2 — failed seed turn stays silent (reload re-fires)', () => {
  test('a failed seed_turn does NOT emit a FAILURE_BODY bubble', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const run = makeRunner({ substrate: makeStubSubstrate({ error: 'boom', specs }), onboarding: true })
    const result = await run(makeTurn({ sent, seed_turn: true }))
    expect(result.outcome).toBe('failed')
    // Nothing persisted/sent — no stuck error bubble; reload regenerates.
    expect(sent.filter((e) => e.type === 'agent_message')).toHaveLength(0)
  })

  test('a failed REAL user turn still emits the anti-silence FAILURE_BODY', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const run = makeRunner({ substrate: makeStubSubstrate({ error: 'boom', specs }), onboarding: true })
    const result = await run(makeTurn({ sent }))
    expect(result.outcome).toBe('failed')
    const msg = sent.find((e) => e.type === 'agent_message') as { body: string }
    expect(msg).toBeDefined()
    expect(msg.body).toContain('I hit a problem answering that')
  })
})
