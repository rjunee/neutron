/**
 * REGRESSION — a background compose failure must never lock the owner out of chat.
 *
 * THE INCIDENT (live instance, 2026-08-17). Reminder composition failed five
 * times. None of those failures was a quota condition: the substrate reported a
 * dead REPL child, retryable and with no HTTP status, and
 * `mapStatusForPoolCooldown(null, retryable=true)` turns exactly that into a 429.
 * Five strikes reached `MAX_CONSECUTIVE_FAILURES`, the pool parked the box's ONE
 * credential for `CONSECUTIVE_COOLDOWN_MS` (an hour), and from then on every owner
 * chat turn died instantly with "all Anthropic credentials are in cooldown
 * (429/402/401)" — a message naming a cause that was not true.
 *
 * The asymmetry is the whole bug: the counter fails CLOSED, and closed means the
 * product goes silent. A lane with nobody waiting on it should not be able to do
 * that, and it is not even a good detector — anything it could discover about the
 * credential the next INTERACTIVE turn discovers immediately, with a real status.
 *
 * Each test here is paired with its INTERACTIVE control, so a regression that
 * quietly widened the exemption to every lane fails too.
 */

import { describe, expect, test } from 'bun:test'

import { buildLlmCallSubstrate } from '../build-llm-call-substrate.ts'
import {
  MAX_CONSECUTIVE_FAILURES,
  hasUsableCredential,
  newCredentialPool,
  reportFailure,
  selectCredential,
  type CredentialPool,
} from '@neutronai/runtime/credential-pool.ts'
import type { ClaudeCodeSubstrateOptions } from '@neutronai/runtime/adapters/claude-code/index.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'

/** The single-credential pool every Open install actually runs on. */
function onePool(): CredentialPool {
  return newCredentialPool({
    strategy: 'fill_first',
    credentials: [{ id: 'anthropic:only', kind: 'oauth', secret: 'tok' }],
  })
}

/**
 * A substrate whose every turn dies the way the incident's did: the persistent
 * REPL's child exited. Retryable, UNSTAMPED, and carrying no HTTP status — so the
 * cooldown mapper can only GUESS, and it guesses 429.
 */
function deadReplSubstrate(pool: CredentialPool, lane: 'interactive' | 'background'): Substrate {
  const substrateFactory = (_opts: ClaudeCodeSubstrateOptions): Substrate => ({
    start(_spec: AgentSpec): SessionHandle {
      const events = (async function* (): AsyncGenerator<Event, void, void> {
        yield {
          kind: 'error',
          message: 'persistent-repl: REPL process exited',
          retryable: true,
        }
      })()
      return {
        events,
        async respondToTool(): Promise<void> {},
        async cancel(): Promise<void> {},
        tool_resolution: 'internal',
      }
    },
  })
  const sub = buildLlmCallSubstrate({
    pool,
    substrate_instance_id: 'cc-probe-owner',
    profile: { skip_permissions: true, github_credential: false, frontier_model_floor: false },
    credential_failure_lane: lane,
    substrateFactory,
  })
  expect(sub).not.toBeNull()
  return sub!
}

/**
 * Fire `n` failing turns, letting the WALL CLOCK move past whatever short
 * per-status cooldown the previous turn set. That is what the real timeline did:
 * a fire cools the credential for a minute, the next reminder comes due later, and
 * it fails again. The strike counter is deliberately NOT reset in between — only a
 * SUCCESS resets it, which is precisely how five ordinary failures compound into an
 * hour-long park.
 */
async function failNTurns(pool: CredentialPool, sub: Substrate, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const cred = pool.credentials[0]!
      if (cred.cooldown_until !== undefined) cred.cooldown_until = Date.now() - 1
    }
    const handle = sub.start({ prompt: 'compose', tools: [], model_preference: ['sonnet'] })
    for await (const _ev of handle.events) {
      /* drain to the terminal error */
    }
  }
}

describe('a background lane cannot park the owner’s credential', () => {
  test('N dead-REPL background failures leave the pool selectable', async () => {
    const pool = onePool()
    await failNTurns(pool, deadReplSubstrate(pool, 'background'), MAX_CONSECUTIVE_FAILURES + 2)

    // The owner's next chat turn resolves a credential instead of dying with
    // "all Anthropic credentials are in cooldown (429/402/401)".
    expect(hasUsableCredential(pool)).toBe(true)
    expect(selectCredential(pool)).not.toBeNull()
    expect(pool.credentials[0]!.consecutive_failures).toBe(0)
    expect(pool.credentials[0]!.cooldown_reason).toBeUndefined()
  })

  test('CONTROL — the same failures on the INTERACTIVE lane still park it', async () => {
    // The exemption is for background lanes only. If this ever goes green, the
    // fix above stopped being a lane distinction and became a hole.
    const pool = onePool()
    await failNTurns(pool, deadReplSubstrate(pool, 'interactive'), MAX_CONSECUTIVE_FAILURES)
    expect(pool.credentials[0]!.cooldown_reason).toBe('consecutive_failures')
    expect(hasUsableCredential(pool)).toBe(false)
  })

  test('CONTROL — an unset lane is interactive, so every existing caller is unchanged', async () => {
    const pool = onePool()
    const substrateFactory = (_opts: ClaudeCodeSubstrateOptions): Substrate => ({
      start(): SessionHandle {
        const events = (async function* (): AsyncGenerator<Event, void, void> {
          yield { kind: 'error', message: 'persistent-repl: REPL process exited', retryable: true }
        })()
        return {
          events,
          async respondToTool(): Promise<void> {},
          async cancel(): Promise<void> {},
          tool_resolution: 'internal',
        }
      },
    })
    const sub = buildLlmCallSubstrate({
      pool,
      substrate_instance_id: 'cc-probe-owner',
      profile: { skip_permissions: true, github_credential: false, frontier_model_floor: false },
      substrateFactory,
    })
    await failNTurns(pool, sub!, MAX_CONSECUTIVE_FAILURES)
    expect(pool.credentials[0]!.cooldown_reason).toBe('consecutive_failures')
  })
})

describe('a REAL provider status still cools on either lane', () => {
  test('a background 401 sets its own short cooldown but never a strike', () => {
    // Honouring real back-pressure is not the bug — inventing it, and then
    // escalating the invention into an hour-long park, was.
    const pool = onePool()
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES + 1; i++) {
      reportFailure(pool, 'anthropic:only', 401, undefined, 'background')
    }
    const cred = pool.credentials[0]!
    expect(cred.cooldown_reason).toBe('auth_401')
    expect(cred.consecutive_failures).toBe(0)
    // 5 minutes, not the hour a strike-park would impose.
    expect(cred.cooldown_until! - Date.now()).toBeLessThanOrEqual(5 * 60_000)
  })

  test('an interactive 401 escalates to the strike park as it always has', () => {
    const pool = onePool()
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
      reportFailure(pool, 'anthropic:only', 401)
    }
    const cred = pool.credentials[0]!
    expect(cred.cooldown_reason).toBe('consecutive_failures')
    expect(cred.consecutive_failures).toBe(MAX_CONSECUTIVE_FAILURES)
  })
})
