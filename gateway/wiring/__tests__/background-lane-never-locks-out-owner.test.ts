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
 *
 * TWO EXEMPTIONS LIVE IN THIS FILE, and they are independent. The LANE exemption
 * (the first three describe blocks) is about who was waiting: a background report
 * may not touch the strike ledger. The DEAD-REPL exemption (the last block) is
 * about what the failure IS: a process that exited is not a credential fault on
 * either lane, so it never reaches the cooldown map at all. The dead-REPL message
 * that opens this docblock is therefore no longer what the lane tests fire — a
 * message the substrate classifies for itself cannot distinguish two lanes, and
 * using it would silently disarm them. They fire a generic inferred failure, and
 * the incident's own message is asserted directly in the last block.
 */

import { describe, expect, test } from 'bun:test'

import { buildLlmCallSubstrate } from '../build-llm-call-substrate.ts'
import {
  COOLDOWN_401_MS,
  COOLDOWN_429_MS,
  CONSECUTIVE_COOLDOWN_MS,
  MAX_CONSECUTIVE_FAILURES,
  hasUsableCredential,
  newCredentialPool,
  reportFailure,
  reportSuccess,
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
 * The persistent REPL's child dying mid-turn — `ReplSession.onDeath`'s exact
 * wording. Retryable, unstamped, no HTTP status. This is the incident's own
 * failure, and `detectReplProcessExited` now suppresses its cooldown on BOTH
 * lanes (see the last describe block), so it is NO LONGER a usable vehicle for
 * testing the lane distinction.
 */
const DEAD_REPL_MESSAGE = 'persistent-repl: REPL process exited'

/**
 * A generic unstamped retryable failure carrying no HTTP status and matching no
 * substrate fast-path — so `mapStatusForPoolCooldown(null, true)` guesses 429 and
 * the LANE is the only thing that decides whether it cools. This is the vehicle
 * for every lane-distinction test below; using a message the substrate classifies
 * for itself would prove nothing about the lane.
 */
const INFERRED_FAILURE_MESSAGE = 'cc-llm-call: upstream stream ended unexpectedly'

/**
 * A failure whose ONLY claim to being an auth condition is the substring `401`
 * sitting in prose — `detectCliAuthFailure`'s weakest rule. Deliberately carries
 * no substrate fast-path prefix, so the LANE decides whether it cools.
 */
const PROSE_401_MESSAGE = 'cc-llm-call: tool call failed with 401 while composing'

/**
 * A substrate whose every turn fails with `message` — UNSTAMPED, exactly like the
 * legacy adapter errors this cooldown path was built for.
 */
function failingSubstrate(
  pool: CredentialPool,
  lane: 'interactive' | 'background',
  message = INFERRED_FAILURE_MESSAGE,
  retryable = true,
): Substrate {
  const substrateFactory = (_opts: ClaudeCodeSubstrateOptions): Substrate => ({
    start(_spec: AgentSpec): SessionHandle {
      const events = (async function* (): AsyncGenerator<Event, void, void> {
        yield { kind: 'error', message, retryable }
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

/** A turn that fails with a cooldown the substrate can only INFER. */
const inferredFailureSubstrate = (
  pool: CredentialPool,
  lane: 'interactive' | 'background',
): Substrate => failingSubstrate(pool, lane)

/** A turn that dies because the REPL child exited — the incident's own shape. */
const deadReplSubstrate = (pool: CredentialPool, lane: 'interactive' | 'background'): Substrate =>
  failingSubstrate(pool, lane, DEAD_REPL_MESSAGE)

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
  test('N inferred background failures leave the pool selectable', async () => {
    const pool = onePool()
    await failNTurns(pool, inferredFailureSubstrate(pool, 'background'), MAX_CONSECUTIVE_FAILURES + 2)

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
    await failNTurns(pool, inferredFailureSubstrate(pool, 'interactive'), MAX_CONSECUTIVE_FAILURES)
    expect(pool.credentials[0]!.cooldown_reason).toBe('consecutive_failures')
    expect(hasUsableCredential(pool)).toBe(false)
  })

  test('CONTROL — an unset lane is interactive, so every existing caller is unchanged', async () => {
    const pool = onePool()
    const substrateFactory = (_opts: ClaudeCodeSubstrateOptions): Substrate => ({
      start(): SessionHandle {
        const events = (async function* (): AsyncGenerator<Event, void, void> {
          yield { kind: 'error', message: INFERRED_FAILURE_MESSAGE, retryable: true }
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
  // THE LINE THIS DRAWS, because it is a real trade and not an oversight: a
  // provider status is a FACT ABOUT THE CREDENTIAL, not about the lane that
  // happened to discover it. A genuine 401 means the owner's next chat turn is
  // going to fail anyway — a second later, with a worse message — so honouring it
  // costs him nothing he had. What the background lane must never do is INVENT
  // one, and never escalate anything into the hour-long park. Both of those are
  // asserted here.
  test('a background 401 sets its own short cooldown but never a strike', () => {
    const pool = onePool()
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES + 1; i++) {
      reportFailure(pool, 'anthropic:only', 401, undefined, 'background')
    }
    const cred = pool.credentials[0]!
    expect(cred.cooldown_reason).toBe('auth_401')
    expect(cred.consecutive_failures).toBe(0)
    // 5 minutes, not the hour a strike-park would impose.
    expect(cred.cooldown_until! - Date.now()).toBeLessThanOrEqual(COOLDOWN_401_MS)
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

  test('a background report cannot RE-EXTEND a park an interactive turn already set', () => {
    // The first cut of this guard skipped only the strike INCREMENT and left the
    // threshold re-check running unconditionally. That is not a fix: once five
    // interactive strikes have set the counter, every later background report
    // re-stamps `cooldown_until` a fresh hour into the future, and the credential
    // never becomes selectable again. Strictly worse than the original bug —
    // permanent instead of hourly, and invisible.
    const pool = onePool()
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) reportFailure(pool, 'anthropic:only', 429)
    const cred = pool.credentials[0]!
    expect(cred.cooldown_reason).toBe('consecutive_failures')

    // The hour passes; the credential is usable again.
    cred.cooldown_until = Date.now() - 1
    expect(hasUsableCredential(pool)).toBe(true)

    // A background nudge fails against a real 429 while the counter still reads 5.
    reportFailure(pool, 'anthropic:only', 429, undefined, 'background')
    expect(cred.cooldown_reason).toBe('rate_limit_429')
    expect(cred.cooldown_until! - Date.now()).toBeLessThanOrEqual(COOLDOWN_429_MS)
  })

  test('CONTROL — an interactive report in that same state DOES re-park', () => {
    const pool = onePool()
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) reportFailure(pool, 'anthropic:only', 429)
    const cred = pool.credentials[0]!
    cred.cooldown_until = Date.now() - 1
    reportFailure(pool, 'anthropic:only', 429)
    expect(cred.cooldown_reason).toBe('consecutive_failures')
    expect(cred.cooldown_until! - Date.now()).toBeGreaterThan(CONSECUTIVE_COOLDOWN_MS / 2)
  })
})

describe('a background report cannot TRUNCATE a park that is still standing', () => {
  // THE THIRD DIRECTION, and the one the two tests above cannot see. Both of them
  // do `cred.cooldown_until = Date.now() - 1` before the background report — they
  // RETIRE the park first, so they only ever prove what happens on a credential
  // that is already selectable again. The dangerous case is the report arriving
  // while the hour is STILL RUNNING: a background turn selected the credential
  // before the interactive lane benched it, and lands its failure afterwards.
  //
  // A plain assignment made that report RELEASE the credential — 401 rewrote an
  // hour of `consecutive_failures` down to five minutes, 429 down to one, and
  // relabelled the reason on the way out. Handing the owner's lane a credential
  // his own strike counter had just judged unfit is worse than either of the
  // failures the counter exists to prevent, and the label made the timeline lie
  // about why. `park` takes the max instead, so a failure only ever extends.

  /** An hour-long `consecutive_failures` park, set the way production sets it. */
  function parkedPool(): { pool: CredentialPool; cred: CredentialPool['credentials'][number] } {
    const pool = onePool()
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) reportFailure(pool, 'anthropic:only', 429)
    const cred = pool.credentials[0]!
    expect(cred.cooldown_reason).toBe('consecutive_failures')
    expect(hasUsableCredential(pool)).toBe(false)
    return { pool, cred }
  }

  test('a background 401 leaves the standing hour untouched, clock AND label', () => {
    const { pool, cred } = parkedPool()
    const until = cred.cooldown_until!

    reportFailure(pool, 'anthropic:only', 401, undefined, 'background')

    expect(cred.cooldown_until).toBe(until)
    expect(cred.cooldown_reason).toBe('consecutive_failures')
    // The credential stays benched. Before `park` it became selectable 55 minutes
    // early, which is the whole defect.
    expect(hasUsableCredential(pool)).toBe(false)
    expect(cred.cooldown_until! - Date.now()).toBeGreaterThan(COOLDOWN_401_MS)
  })

  test('a background 429 leaves it untouched too — the shortest window of all', () => {
    const { pool, cred } = parkedPool()
    const until = cred.cooldown_until!

    reportFailure(pool, 'anthropic:only', 429, undefined, 'background')

    expect(cred.cooldown_until).toBe(until)
    expect(cred.cooldown_reason).toBe('consecutive_failures')
    expect(hasUsableCredential(pool)).toBe(false)
    expect(cred.cooldown_until! - Date.now()).toBeGreaterThan(COOLDOWN_429_MS)
  })

  test('and the strike counter is still neither incremented nor re-read', () => {
    // The property PR #356 established, re-asserted here so a fix to truncation
    // cannot be mistaken for permission to touch the ledger from a timer.
    const { pool, cred } = parkedPool()
    expect(cred.consecutive_failures).toBe(MAX_CONSECUTIVE_FAILURES)

    reportFailure(pool, 'anthropic:only', 401, undefined, 'background')
    reportFailure(pool, 'anthropic:only', 429, undefined, 'background')

    expect(cred.consecutive_failures).toBe(MAX_CONSECUTIVE_FAILURES)
  })

  test('a LONGER background park still applies — this is a floor, not a freeze', () => {
    // The rule must not become "a standing park wins", or a real two-hour
    // `retry-after` would be swallowed by whatever short park happened to be
    // running and we would hammer a provider that told us not to.
    const { pool, cred } = parkedPool()
    const twoHours = 2 * 60 * 60_000

    reportFailure(pool, 'anthropic:only', 429, twoHours, 'background')

    expect(cred.cooldown_reason).toBe('rate_limit_429')
    expect(cred.cooldown_until! - Date.now()).toBeGreaterThan(CONSECUTIVE_COOLDOWN_MS)
  })

  test('an INTERACTIVE report cannot truncate a standing park either', () => {
    // Same defect, same fix, no lane condition. A 30-minute `billing_402` park is
    // a statement about the credential that a 60-second 429 has no standing to
    // overrule — and unlike the strike park there is no threshold re-check
    // downstream to accidentally repair it.
    const pool = onePool()
    reportFailure(pool, 'anthropic:only', 402)
    const cred = pool.credentials[0]!
    const until = cred.cooldown_until!
    expect(cred.cooldown_reason).toBe('billing_402')

    reportFailure(pool, 'anthropic:only', 429)

    expect(cred.cooldown_until).toBe(until)
    expect(cred.cooldown_reason).toBe('billing_402')
  })

  test('CONTROL — reportSuccess is still the ONE thing that releases a park', () => {
    // Monotonic under FAILURE only. If a confirmed working dispatch stopped
    // clearing the park, the fix would have turned every cooldown into a
    // sentence the credential cannot appeal.
    const { pool, cred } = parkedPool()
    reportSuccess(pool, 'anthropic:only')
    expect(cred.cooldown_until).toBeUndefined()
    expect(cred.cooldown_reason).toBeUndefined()
    expect(cred.consecutive_failures).toBe(0)
    expect(hasUsableCredential(pool)).toBe(true)
  })

  test('CONTROL — an EXPIRED park is not a park, so a fresh report still cools', () => {
    // The guard reads `cooldown_until >= proposed`, and a past timestamp never
    // is. If it compared truthiness instead, a credential whose hour had elapsed
    // would stop honouring the provider's next 429 entirely.
    const { pool, cred } = parkedPool()
    cred.cooldown_until = Date.now() - 1

    reportFailure(pool, 'anthropic:only', 429, undefined, 'background')

    expect(cred.cooldown_reason).toBe('rate_limit_429')
    expect(cred.cooldown_until! - Date.now()).toBeGreaterThan(0)
    expect(cred.cooldown_until! - Date.now()).toBeLessThanOrEqual(COOLDOWN_429_MS)
  })
})

describe('the substrate THREADS the lane into reportFailure, not just past it', () => {
  // WHY THIS SUITE EXISTS. Every test above this point drives the background lane
  // with an INFERRED cooldown, which the substrate declines to report at all — so
  // `reportFailure` is never called on that path, and the `origin` argument the
  // production wiring passes was never executed by a single assertion. Deleting
  // that argument from all four call sites left the whole file green while
  // restoring the hour-long park in production. These tests take the one path
  // where a background failure DOES reach the pool.

  test('CLAUDE PATH — a real 429 on the background lane cools, and never accumulates', async () => {
    const pool = onePool()
    const sub = failingSubstrate(pool, 'background', 'HTTP 429: too many requests', true)
    await failNTurns(pool, sub, MAX_CONSECUTIVE_FAILURES + 2)
    const cred = pool.credentials[0]!
    expect(cred.cooldown_reason).toBe('rate_limit_429')
    expect(cred.consecutive_failures).toBe(0)
    // The provider's own 60s window, not the hour — and it expires on its own.
    expect(cred.cooldown_until! - Date.now()).toBeLessThanOrEqual(COOLDOWN_429_MS)
  })

  test('CLAUDE PATH CONTROL — the same real 429s on the interactive lane still park', async () => {
    const pool = onePool()
    const sub = failingSubstrate(pool, 'interactive', 'HTTP 429: too many requests', true)
    await failNTurns(pool, sub, MAX_CONSECUTIVE_FAILURES)
    const cred = pool.credentials[0]!
    expect(cred.cooldown_reason).toBe('consecutive_failures')
    expect(cred.cooldown_until! - Date.now()).toBeGreaterThan(COOLDOWN_429_MS)
  })

  test('CLAUDE PATH — a prose "401" is an INFERENCE and cools nothing on the background lane', async () => {
    // `detectCliAuthFailure` returns true for the substring `401` appearing
    // ANYWHERE in the message (`runtime`-facing prose, a tool's echoed HTTP line, a
    // path, a pid). The first cut of this guard treated it as a provider status, so
    // a crashed background REPL whose tail happened to contain those three digits
    // walked straight through the exemption and cooled the owner's only credential.
    const pool = onePool()
    const sub = failingSubstrate(pool, 'background', PROSE_401_MESSAGE, false)
    await failNTurns(pool, sub, MAX_CONSECUTIVE_FAILURES + 2)
    const cred = pool.credentials[0]!
    expect(cred.cooldown_reason).toBeUndefined()
    expect(cred.cooldown_until).toBeUndefined()
    expect(hasUsableCredential(pool)).toBe(true)
  })

  test('CLAUDE PATH CONTROL — that same prose still cools an INTERACTIVE turn', async () => {
    const pool = onePool()
    const sub = failingSubstrate(pool, 'interactive', PROSE_401_MESSAGE, false)
    await failNTurns(pool, sub, 1)
    expect(pool.credentials[0]!.cooldown_reason).toBe('auth_401')
  })

  test('OPENAI PATH — a real 429 on the background lane cools, and never accumulates', async () => {
    // The OpenAI family has its own dispatch loop and its own `reportFailure` call
    // sites; the lane has to be threaded there too, and a mutation that drops it is
    // otherwise invisible.
    const openai = newCredentialPool({
      strategy: 'fill_first',
      credentials: [{ id: 'openai:only', kind: 'api_key', secret: 'sk-openai' }],
    })
    const sub = buildLlmCallSubstrate({
      pool: onePool(),
      substrate_instance_id: 'cc-probe-owner',
      provider: 'openai',
      user_id: 'owner',
      credential_failure_lane: 'background',
      openai: {
        pool: openai,
        bindMcpResolver: () => async () => ({}),
        model_preference: ['gpt-5.6'],
        // No `retry-after` header — the branch the CC path can never reach, since
        // no claude-code adapter populates `retry_after_ms`.
        fetchImpl: (async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch,
      },
    })!
    await failNTurns(openai, sub, MAX_CONSECUTIVE_FAILURES + 2)
    const cred = openai.credentials[0]!
    expect(cred.cooldown_reason).toBe('rate_limit_429')
    expect(cred.consecutive_failures).toBe(0)
    expect(cred.cooldown_until! - Date.now()).toBeLessThanOrEqual(COOLDOWN_429_MS)
  })

  test('OPENAI PATH CONTROL — the same failures on the interactive lane still park', async () => {
    const openai = newCredentialPool({
      strategy: 'fill_first',
      credentials: [{ id: 'openai:only', kind: 'api_key', secret: 'sk-openai' }],
    })
    const sub = buildLlmCallSubstrate({
      pool: onePool(),
      substrate_instance_id: 'cc-probe-owner',
      provider: 'openai',
      user_id: 'owner',
      openai: {
        pool: openai,
        bindMcpResolver: () => async () => ({}),
        model_preference: ['gpt-5.6'],
        fetchImpl: (async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch,
      },
    })!
    await failNTurns(openai, sub, MAX_CONSECUTIVE_FAILURES)
    expect(openai.credentials[0]!.cooldown_reason).toBe('consecutive_failures')
  })
})

describe('a dead REPL child never cools a credential, on EITHER lane', () => {
  // THE HALF THE LANE SPLIT CANNOT REACH. Giving the nudge lane its own REPL stops
  // a background compose from tearing down the owner's session. It does NOT stop
  // what actually parked the pool in the incident: once his warm child had been
  // poisoned and evicted, HIS OWN next turns failed with `persistent-repl: REPL
  // process exited` — interactive by definition, so every one of them drew a
  // strike. Five retries bought an hour of "all Anthropic credentials are in
  // cooldown (429/402/401)" on a box whose credential was never the problem.
  //
  // A dead process is a local substrate fact. It carries no HTTP status, so the
  // mapper can only guess, and it guesses 429 — laundering a crash into a quota
  // lie. The pool already self-heals by respawning a clean child, and that recovery
  // only works if the credential is not parked underneath it.

  test('the owner retrying into a respawning REPL never parks his own credential', async () => {
    const pool = onePool()
    await failNTurns(pool, deadReplSubstrate(pool, 'interactive'), MAX_CONSECUTIVE_FAILURES + 2)

    const cred = pool.credentials[0]!
    expect(cred.consecutive_failures).toBe(0)
    expect(cred.cooldown_reason).toBeUndefined()
    expect(cred.cooldown_until).toBeUndefined()
    // The next turn resolves a credential instead of dying instantly on a lie.
    expect(hasUsableCredential(pool)).toBe(true)
    expect(selectCredential(pool)).not.toBeNull()
  })

  test('and neither does the background lane', async () => {
    const pool = onePool()
    await failNTurns(pool, deadReplSubstrate(pool, 'background'), MAX_CONSECUTIVE_FAILURES + 2)

    const cred = pool.credentials[0]!
    expect(cred.consecutive_failures).toBe(0)
    expect(cred.cooldown_until).toBeUndefined()
    expect(hasUsableCredential(pool)).toBe(true)
  })

  test('the error still SURFACES retryable — suppressed cooldown, not a swallowed failure', async () => {
    const pool = onePool()
    const sub = deadReplSubstrate(pool, 'interactive')
    const seen: Event[] = []
    const handle = sub.start({ prompt: 'hi', tools: [], model_preference: ['sonnet'] })
    for await (const ev of handle.events) seen.push(ev)

    const err = seen.find((e) => e.kind === 'error')
    expect(err).toBeDefined()
    // Unchanged and retryable, so the caller retries onto the respawned child —
    // NOT rewritten into a terminal "credentials in cooldown" message.
    expect(err!.kind === 'error' && err!.message).toBe(DEAD_REPL_MESSAGE)
    expect(err!.kind === 'error' && err!.retryable).toBe(true)
  })

  test('a dead REPL whose stderr tail merely MENTIONS 401 still cools nothing', async () => {
    // Precedence: the process death is the authoritative fact, and
    // `detectCliAuthFailure`'s substring rule is the weakest inference in the file.
    // A tool call inside the turn returning 401 says nothing about the credential
    // the turn was dispatched on.
    const pool = onePool()
    const sub = failingSubstrate(
      pool,
      'interactive',
      `${DEAD_REPL_MESSAGE}; last stderr line: tool call failed with 401`,
      false,
    )
    await failNTurns(pool, sub, MAX_CONSECUTIVE_FAILURES)
    const cred = pool.credentials[0]!
    expect(cred.cooldown_reason).toBeUndefined()
    expect(hasUsableCredential(pool)).toBe(true)
  })

  test('CONTROL — the exemption is for THIS shape only, not retryable errors at large', async () => {
    // If this ever goes green, the fast-path stopped being a classification and
    // became a blanket amnesty for every unstamped retryable failure.
    const pool = onePool()
    await failNTurns(pool, inferredFailureSubstrate(pool, 'interactive'), MAX_CONSECUTIVE_FAILURES)
    expect(pool.credentials[0]!.cooldown_reason).toBe('consecutive_failures')
    expect(hasUsableCredential(pool)).toBe(false)
  })

  test('CONTROL — a REAL provider 429 on the interactive lane still cools', async () => {
    const pool = onePool()
    const sub = failingSubstrate(pool, 'interactive', 'HTTP 429: too many requests', true)
    await failNTurns(pool, sub, 1)
    expect(pool.credentials[0]!.cooldown_reason).toBe('rate_limit_429')
  })
})
