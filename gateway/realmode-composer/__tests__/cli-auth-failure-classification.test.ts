/**
 * ISSUES #50 (2026-05-28) — CC-substrate auth failures route through
 * `auth_401` cooldown so the credential pool rotates off bad credentials.
 *
 * S3 rip-replace (2026-06-07): exercised through the `substrateFactory` seam —
 * a fake `Substrate` that yields the terminal error events the composer
 * classifies (the substrate, not a parsed `claude -p` stdout, is the source of
 * the `Event`s now). The classification contract is unchanged.
 *
 * The composer's classification block runs `parseHttpStatusFromMessage()`, then
 * `detectCliAuthFailure(message)` (matches `/invalid api key/i`,
 * `/authentication.*failed/i`, `/401/`), then `mapStatusForPoolCooldown(...)`.
 * An auth-signature message → `reportFailure(pool, id, 401)` → 5-min cooldown +
 * `cooldown_reason='auth_401'` → next `start()` rotates credentials.
 *
 * Six tests below pin the contract:
 *   1. `Invalid API key` → auth_401 cooldown + rotation
 *   2. `Authentication failed` → auth_401 cooldown + rotation
 *   3. Embedded `HTTP 401 Unauthorized` substring → auth_401 cooldown + rotation
 *   4. Non-auth non-retryable error → NO cooldown (no false positive)
 *   5. Rate-limit (429-class) still classifies correctly (no regression)
 *   6. Bare `claude exited 1` (no signature) → no auth detection fires (defensive)
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildImportSubstrate } from '../build-import-substrate.ts'
import type { ClaudeCodeSubstrateOptions } from '../../../runtime/adapters/claude-code/index.ts'
import { newCredentialPool } from '../../../runtime/credential-pool.ts'
import type { AgentSpec, Substrate } from '../../../runtime/substrate.ts'
import type { SessionHandle } from '../../../runtime/session-handle.ts'
import type { Event } from '../../../runtime/events.ts'

let workdir: string

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'neutron-iss50-'))
})

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true })
})

interface AuthFailureEmit {
  /** stderr-tail body folded into the synthesised `claude exited <code>: <tail>` message. */
  stderr?: string
  /** subprocess exit code (folded into the message). Defaults to 1. */
  exitCode?: number
}

/**
 * Fake substrate factory that yields canned terminal error events shaped like
 * the prior cli-transport synthesis (`claude exited <code>: <stderr-tail>` for
 * auth failures, `rate_limit: <body>` for rate-limits, `error_input_too_long:
 * <body>` for request errors). Captures the composed options (env) per spawn so
 * rotation assertions can read the selected credential.
 */
function captureAuthFailureFactory(): {
  substrateFactory: (opts: ClaudeCodeSubstrateOptions) => Substrate
  seen: Array<{ opts: ClaudeCodeSubstrateOptions; spec: AgentSpec }>
  emitAuthFailure: (opts: AuthFailureEmit) => void
  emitRateLimit: (body: string) => void
  emitRequestError: (body: string) => void
} {
  const seen: Array<{ opts: ClaudeCodeSubstrateOptions; spec: AgentSpec }> = []
  type Behaviour =
    | { kind: 'success' }
    | { kind: 'auth_failure'; opts: AuthFailureEmit }
    | { kind: 'rate_limit'; body: string }
    | { kind: 'request_error'; body: string }
  const queue: Behaviour[] = []
  const nextBehaviour = (): Behaviour => queue.shift() ?? { kind: 'success' }

  const errorEvent = (b: Exclude<Behaviour, { kind: 'success' }>): Event => {
    if (b.kind === 'auth_failure') {
      const code = b.opts.exitCode ?? 1
      const tail = b.opts.stderr !== undefined && b.opts.stderr.length > 0 ? `: ${b.opts.stderr}` : ''
      // Mirror the prior synthesis: the `claude exited <code>` prefix means
      // parseHttpStatusFromMessage (anchored `^HTTP`) never matches, so an
      // embedded `HTTP 401` is only caught by detectCliAuthFailure's /401/.
      return { kind: 'error', message: `claude exited ${code}${tail}`, retryable: false }
    }
    if (b.kind === 'rate_limit') {
      return { kind: 'error', message: `rate_limit: ${b.body}`, retryable: true }
    }
    return { kind: 'error', message: `error_input_too_long: ${b.body}`, retryable: false }
  }

  const substrateFactory = (opts: ClaudeCodeSubstrateOptions): Substrate => ({
    start(spec: AgentSpec): SessionHandle {
      seen.push({ opts, spec })
      const behaviour = nextBehaviour()
      const events = (async function* (): AsyncGenerator<Event, void, void> {
        if (behaviour.kind === 'success') {
          yield {
            kind: 'completion',
            substrate_instance_id: opts.substrate_instance_id,
            session: { id: 'sess', last_active_at: Date.now() },
            usage: { input_tokens: 1, output_tokens: 1 },
          }
          return
        }
        yield errorEvent(behaviour)
      })()
      return {
        events,
        respondToTool: async () => undefined,
        cancel: async () => undefined,
        tool_resolution: 'internal',
      }
    },
  })

  return {
    substrateFactory,
    seen,
    emitAuthFailure(opts: AuthFailureEmit): void {
      queue.push({ kind: 'auth_failure', opts })
    },
    emitRateLimit(body: string): void {
      queue.push({ kind: 'rate_limit', body })
    },
    emitRequestError(body: string): void {
      queue.push({ kind: 'request_error', body })
    },
  }
}

function runSpec(): AgentSpec {
  return {
    prompt: 'hi',
    tools: [],
    model_preference: ['claude-haiku-4-5-20251001'],
  }
}

test('ISSUES #50 case 1 — `Invalid API key` → auth_401 cooldown + next start() rotates to other credential', async () => {
  const pool = newCredentialPool({
    strategy: 'fill_first',
    credentials: [
      { id: 'k1', kind: 'api_key', secret: 'sk-bad' },
      { id: 'k2', kind: 'api_key', secret: 'sk-good' },
    ],
  })
  const cap = captureAuthFailureFactory()
  cap.emitAuthFailure({ stderr: 'error: Invalid API key', exitCode: 1 })
  const sub = buildImportSubstrate({
    pool,
    substrate_instance_id: 'cc',
    cwd: workdir,
    substrateFactory: cap.substrateFactory,
  })
  expect(sub).not.toBeNull()
  // First dispatch — k1 hits auth failure → k1 cooldown set.
  const h1 = sub!.start(runSpec())
  for await (const _ev of h1.events) {
    // drain
  }
  expect(cap.seen[0]!.opts.env?.['ANTHROPIC_API_KEY']).toBe('sk-bad')
  expect(pool.credentials[0]!.cooldown_reason).toBe('auth_401')
  expect(pool.credentials[0]!.cooldown_until).toBeDefined()
  // Second dispatch — pool MUST rotate off k1 (cooldown active) and pick k2.
  const h2 = sub!.start(runSpec())
  for await (const _ev of h2.events) {
    // drain
  }
  expect(cap.seen[1]!.opts.env?.['ANTHROPIC_API_KEY']).toBe('sk-good')
})

test('ISSUES #50 case 2 — `Authentication failed` → auth_401 cooldown + rotation', async () => {
  const pool = newCredentialPool({
    strategy: 'fill_first',
    credentials: [
      { id: 'k1', kind: 'api_key', secret: 'sk-bad' },
      { id: 'k2', kind: 'api_key', secret: 'sk-good' },
    ],
  })
  const cap = captureAuthFailureFactory()
  cap.emitAuthFailure({ stderr: 'Authentication failed: token expired', exitCode: 1 })
  const sub = buildImportSubstrate({
    pool,
    substrate_instance_id: 'cc',
    cwd: workdir,
    substrateFactory: cap.substrateFactory,
  })
  const h1 = sub!.start(runSpec())
  for await (const _ev of h1.events) {
    // drain
  }
  expect(pool.credentials[0]!.cooldown_reason).toBe('auth_401')
  expect(pool.credentials[0]!.cooldown_until).toBeDefined()
  // Next start() rotates.
  const h2 = sub!.start(runSpec())
  for await (const _ev of h2.events) {
    // drain
  }
  expect(cap.seen[1]!.opts.env?.['ANTHROPIC_API_KEY']).toBe('sk-good')
})

test('ISSUES #50 case 3 — embedded `HTTP 401 Unauthorized` substring → auth_401 cooldown + rotation (substring /401/ regex)', async () => {
  // The message `claude exited 1: HTTP 401 Unauthorized` does NOT match
  // parseHttpStatusFromMessage's `^HTTP\s+(\d{3})\b` (prefix is `claude`), so the
  // detectCliAuthFailure `/401/` substring regex is the only thing that catches it.
  const pool = newCredentialPool({
    strategy: 'fill_first',
    credentials: [
      { id: 'k1', kind: 'api_key', secret: 'sk-bad' },
      { id: 'k2', kind: 'api_key', secret: 'sk-good' },
    ],
  })
  const cap = captureAuthFailureFactory()
  cap.emitAuthFailure({ stderr: 'HTTP 401 Unauthorized', exitCode: 1 })
  const sub = buildImportSubstrate({
    pool,
    substrate_instance_id: 'cc',
    cwd: workdir,
    substrateFactory: cap.substrateFactory,
  })
  const h1 = sub!.start(runSpec())
  for await (const _ev of h1.events) {
    // drain
  }
  expect(pool.credentials[0]!.cooldown_reason).toBe('auth_401')
  expect(pool.credentials[0]!.cooldown_until).toBeDefined()
  const h2 = sub!.start(runSpec())
  for await (const _ev of h2.events) {
    // drain
  }
  expect(cap.seen[1]!.opts.env?.['ANTHROPIC_API_KEY']).toBe('sk-good')
})

test('ISSUES #50 case 4 — non-auth non-retryable error (`input too long`) → NO cooldown (no false positive on the new detection)', async () => {
  const pool = newCredentialPool({
    strategy: 'fill_first',
    credentials: [
      { id: 'k1', kind: 'api_key', secret: 'sk-bad' },
      { id: 'k2', kind: 'api_key', secret: 'sk-good' },
    ],
  })
  const cap = captureAuthFailureFactory()
  // The `error_input_too_long: input too long` message matches none of
  // /invalid api key/i, /authentication.*failed/i, /401/ → detectCliAuthFailure
  // false → mapStatusForPoolCooldown(null, false) → null → reportFailure skipped.
  cap.emitRequestError('input too long')
  const sub = buildImportSubstrate({
    pool,
    substrate_instance_id: 'cc',
    cwd: workdir,
    substrateFactory: cap.substrateFactory,
  })
  const h = sub!.start(runSpec())
  for await (const _ev of h.events) {
    // drain
  }
  // ASSERT — k1 NOT parked, consecutive_failures unchanged.
  expect(pool.credentials[0]!.cooldown_until).toBeUndefined()
  expect(pool.credentials[0]!.cooldown_reason).toBeUndefined()
  expect(pool.credentials[0]!.consecutive_failures).toBe(0)
  // Next start() still serves k1 (fill_first, no cooldown).
  const h2 = sub!.start(runSpec())
  for await (const _ev of h2.events) {
    // drain
  }
  expect(cap.seen[1]!.opts.env?.['ANTHROPIC_API_KEY']).toBe('sk-bad')
})

test('ISSUES #50 case 5 — pre-existing rate-limit (429-class) path still classifies correctly (no regression)', async () => {
  // The rate-limit error message `rate_limit: You've hit your limit · resets ...`
  // matches none of the three auth signatures, so the wrapper proceeds to
  // mapStatusForPoolCooldown(null, retryable=true) → 429-class.
  const pool = newCredentialPool({
    strategy: 'fill_first',
    credentials: [
      { id: 'k1', kind: 'api_key', secret: 'sk-1' },
      { id: 'k2', kind: 'api_key', secret: 'sk-2' },
    ],
  })
  const cap = captureAuthFailureFactory()
  cap.emitRateLimit("You've hit your limit · resets 3:20am (America/Los_Angeles)")
  const sub = buildImportSubstrate({
    pool,
    substrate_instance_id: 'cc',
    cwd: workdir,
    substrateFactory: cap.substrateFactory,
  })
  const h = sub!.start(runSpec())
  for await (const _ev of h.events) {
    // drain
  }
  expect(pool.credentials[0]!.cooldown_reason).toBe('rate_limit_429')
  expect(pool.credentials[0]!.cooldown_until).toBeDefined()
})

test('ISSUES #50 case 6 — bare `claude exited 1` (no signature) → no auth detection fires (defensive)', async () => {
  // A bare `claude exited 1` message (no stderr tail) matches no auth signature,
  // so detectCliAuthFailure returns false and the non-retryable fallback →
  // null → reportFailure SKIPPED. Pins that detection only fires on actual
  // auth-signature messages, not on every non-zero exit.
  const pool = newCredentialPool({
    strategy: 'fill_first',
    credentials: [
      { id: 'k1', kind: 'api_key', secret: 'sk-1' },
      { id: 'k2', kind: 'api_key', secret: 'sk-2' },
    ],
  })
  const cap = captureAuthFailureFactory()
  cap.emitAuthFailure({ stderr: '', exitCode: 1 })
  const sub = buildImportSubstrate({
    pool,
    substrate_instance_id: 'cc',
    cwd: workdir,
    substrateFactory: cap.substrateFactory,
  })
  const h = sub!.start(runSpec())
  for await (const _ev of h.events) {
    // drain
  }
  // ASSERT — k1 NOT parked. A bare `claude exited 1` is ambiguous; the
  // conservative contract is "don't punish the credential without evidence".
  expect(pool.credentials[0]!.cooldown_until).toBeUndefined()
  expect(pool.credentials[0]!.cooldown_reason).toBeUndefined()
})
