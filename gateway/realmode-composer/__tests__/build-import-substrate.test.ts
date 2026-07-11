/**
 * `buildImportSubstrate` regression tests.
 *
 * S3 rip-replace (2026-06-07): the persistent interactive-REPL is the SOLE
 * substrate (cli-transport `claude -p` deleted). These tests exercise the import
 * composer's credential discipline (per-call selection + rotation, ISSUES-#49
 * env scrubbing, Max-OAuth refresh, cooldown classification) through the
 * `substrateFactory` seam — a fake `Substrate` that captures the composed options
 * (incl. the scrubbed env) + spec and yields canned `Event`s. No real `claude`
 * REPL spawns.
 *
 * Codex r1 P1 findings still covered:
 *   1. Per-call credential selection (rotation honoured mid-import).
 *   2. Cooldown matrix (429 / overloaded / request-level / network failure / oauth refresh).
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildImportSubstrate } from '../build-import-substrate.ts'
import type { ClaudeCodeSubstrateOptions } from '@neutronai/runtime/adapters/claude-code/index.ts'
import {
  COOLDOWN_429_MS,
  newCredentialPool,
  reportFailure,
  type CredentialPool,
} from '@neutronai/runtime/credential-pool.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'

let workdir: string

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'neutron-t7-bis-'))
})

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true })
})

interface ErrorEmit {
  /** retryable flag on the yielded error event (drives cooldown classification). */
  retryable: boolean
  /** error message; defaults to a rate_limit-shaped body. */
  message?: string
}

/**
 * A fake substrate factory that captures the composed `ClaudeCodeSubstrateOptions`
 * + spec per `start()` and yields canned `Event`s. Replaces the old cli-transport
 * `spawnImpl` stub: the composer now classifies the substrate's events directly,
 * so the fake yields the terminal completion/error events.
 */
function captureFactory(): {
  substrateFactory: (opts: ClaudeCodeSubstrateOptions) => Substrate
  seen: Array<{ opts: ClaudeCodeSubstrateOptions; spec: AgentSpec }>
  emitResult: () => void
  emitError: (opts: ErrorEmit) => void
} {
  const seen: Array<{ opts: ClaudeCodeSubstrateOptions; spec: AgentSpec }> = []
  type Behaviour = { kind: 'success' } | { kind: 'error'; opts: ErrorEmit }
  const queue: Behaviour[] = []
  const nextBehaviour = (): Behaviour => queue.shift() ?? { kind: 'success' }

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
        yield {
          kind: 'error',
          message: behaviour.opts.message ?? 'rate_limit: You’ve hit your limit',
          retryable: behaviour.opts.retryable,
        }
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
    emitResult(): void {
      queue.push({ kind: 'success' })
    },
    emitError(opts: ErrorEmit): void {
      queue.push({ kind: 'error', opts })
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

test('buildImportSubstrate returns null when the pool is empty (no credentials)', () => {
  const pool = newCredentialPool({ strategy: 'fill_first', credentials: [] })
  const sub = buildImportSubstrate({
    pool,
    substrate_instance_id: 'x',
  })
  expect(sub).toBeNull()
})

test('Codex P1 — credential selection happens per start() call (rotation honoured mid-import)', async () => {
  const pool = newCredentialPool({
    strategy: 'round_robin',
    credentials: [
      { id: 'k1', kind: 'api_key', secret: 'sk-test-1' },
      { id: 'k2', kind: 'api_key', secret: 'sk-test-2' },
    ],
  })
  const { substrateFactory, seen } = captureFactory()
  const sub = buildImportSubstrate({
    pool,
    substrate_instance_id: 'cc',
    cwd: workdir,
    substrateFactory,
  })
  expect(sub).not.toBeNull()
  // Drain three consecutive start() calls — round_robin should
  // alternate the ANTHROPIC_API_KEY env value across them.
  for (let i = 0; i < 3; i++) {
    const h = sub!.start(runSpec())
    for await (const _ev of h.events) {
      // drain
    }
  }
  expect(seen.length).toBe(3)
  const keys = seen.map((r) => r.opts.env?.['ANTHROPIC_API_KEY'])
  // round_robin alternates: k1 → k2 → k1.
  expect(keys[0]).toBe('sk-test-1')
  expect(keys[1]).toBe('sk-test-2')
  expect(keys[2]).toBe('sk-test-1')
})

test('Argus r6 (Codex) — import substrate is marked ephemeral so session-less chunks never share a warm transcript', async () => {
  // The cc-import-* pool key is stable (instance id + credential + project) and
  // no import caller sets spec.session, so without `ephemeral` every Pass-1
  // chunk + the Pass-2 synthesis would collapse into ONE shared Claude
  // transcript → cross-chunk contamination of UNTRUSTED export content +
  // unbounded growth. Assert the composed options carry `ephemeral: true` on
  // EVERY start() (the flag is what routes each session-less turn through a
  // fresh disposable REPL, restoring pre-S3 `claude -p` one-shot semantics).
  const pool = newCredentialPool({
    strategy: 'fill_first',
    credentials: [{ id: 'k1', kind: 'api_key', secret: 'sk-test-1' }],
  })
  const { substrateFactory, seen } = captureFactory()
  const sub = buildImportSubstrate({
    pool,
    substrate_instance_id: 'cc',
    cwd: workdir,
    substrateFactory,
  })
  expect(sub).not.toBeNull()
  for (let i = 0; i < 2; i++) {
    const h = sub!.start(runSpec())
    for await (const _ev of h.events) {
      // drain
    }
  }
  expect(seen.length).toBe(2)
  expect(seen[0]!.opts.ephemeral).toBe(true)
  expect(seen[1]!.opts.ephemeral).toBe(true)
})

test('Codex P1 — cooldown set after construction is honoured on subsequent start() calls', async () => {
  const pool = newCredentialPool({
    strategy: 'fill_first',
    credentials: [
      { id: 'k1', kind: 'api_key', secret: 'sk-test-1' },
      { id: 'k2', kind: 'api_key', secret: 'sk-test-2' },
    ],
  })
  const { substrateFactory, seen } = captureFactory()
  const sub = buildImportSubstrate({
    pool,
    substrate_instance_id: 'cc',
    cwd: workdir,
    substrateFactory,
  })
  expect(sub).not.toBeNull()
  // First call uses k1.
  const h1 = sub!.start(runSpec())
  for await (const _ev of h1.events) {
    // drain
  }
  expect(seen[0]!.opts.env?.['ANTHROPIC_API_KEY']).toBe('sk-test-1')
  // Mark k1 as rate-limited; pool selection MUST skip it on the next
  // start. The prior shape (Codex P1) baked k1's secret into the
  // substrate's env at construction, so this rotation would never fire.
  reportFailure(pool, 'k1', 429)
  const h2 = sub!.start(runSpec())
  for await (const _ev of h2.events) {
    // drain
  }
  expect(seen[1]!.opts.env?.['ANTHROPIC_API_KEY']).toBe('sk-test-2')
})

test('Codex P1 / S13 — every credential in cooldown → events yield error (substrate_error path)', async () => {
  const pool = newCredentialPool({
    strategy: 'fill_first',
    credentials: [
      { id: 'k1', kind: 'api_key', secret: 'sk-test-1' },
    ],
  })
  reportFailure(pool, 'k1', 429)
  const sub = buildImportSubstrate({
    pool,
    substrate_instance_id: 'cc',
    cwd: workdir,
  })
  expect(sub).not.toBeNull()
  // S13 (2026-05-16) — credential resolution moved INSIDE the events
  // generator so the lazy-resolve path can await `resolvePool()`
  // before selecting. As a side-effect, the cooldown-only-empty case
  // now yields an `{kind:'error'}` event instead of throwing
  // synchronously. `substrate-callers.ts` converts that into an
  // `ImportError('substrate_error')` for the runner, which is what
  // production cares about. This test validates the new contract
  // surface; `substrate-callers.test.ts` covers the runner-facing
  // ImportError mapping.
  const h = sub!.start(runSpec())
  const events: Event[] = []
  for await (const ev of h.events) {
    events.push(ev)
  }
  expect(events.length).toBeGreaterThan(0)
  const err = events.find((e) => e.kind === 'error')
  expect(err).toBeDefined()
  expect(err!.kind === 'error' && /cooldown/i.test(err!.message)).toBe(true)
})

test('2026-06-17 (import-analysis-completeness) — all-cooldown error carries retry_after_ms = soonest cooldown window so the runner waits the right amount', async () => {
  const pool = newCredentialPool({
    strategy: 'fill_first',
    credentials: [{ id: 'k1', kind: 'api_key', secret: 'sk-test-1' }],
  })
  // Single-credential (single-Max owner) pool — a 429 parks the whole pool.
  reportFailure(pool, 'k1', 429)
  const sub = buildImportSubstrate({
    pool,
    substrate_instance_id: 'cc',
    cwd: workdir,
  })
  expect(sub).not.toBeNull()
  const h = sub!.start(runSpec())
  const events: Event[] = []
  for await (const ev of h.events) {
    events.push(ev)
  }
  const err = events.find((e) => e.kind === 'error')
  expect(err).toBeDefined()
  // The runner reads this duration to sleep for the ACTUAL quota-reset
  // window (≈ COOLDOWN_429_MS) instead of guessing with a fixed backoff.
  const retryAfter = err!.kind === 'error' ? err!.retry_after_ms : undefined
  expect(typeof retryAfter).toBe('number')
  expect(retryAfter!).toBeGreaterThan(0)
  expect(retryAfter!).toBeLessThanOrEqual(COOLDOWN_429_MS)
})

test('Codex P1 — oauth credentials produce CLAUDE_CODE_OAUTH_TOKEN env var, not ANTHROPIC_API_KEY', async () => {
  const pool = newCredentialPool({
    strategy: 'fill_first',
    credentials: [{ id: 'm1', kind: 'oauth', secret: 'mx-oauth-token-1' }],
  })
  const { substrateFactory, seen } = captureFactory()
  const sub = buildImportSubstrate({
    pool,
    substrate_instance_id: 'cc',
    cwd: workdir,
    substrateFactory,
  })
  const h = sub!.start(runSpec())
  for await (const _ev of h.events) {
    // drain
  }
  // The OAuth secret is the RAW `CLAUDE_CODE_OAUTH_TOKEN` env var value — no
  // Bearer prefix. The `claude` binary itself wraps it into the HTTP header.
  expect(seen[0]!.opts.env?.['CLAUDE_CODE_OAUTH_TOKEN']).toBe('mx-oauth-token-1')
  // ANTHROPIC_API_KEY is explicitly scrubbed (undefined) for oauth creds.
  const scrubbedApiKey = seen[0]!.opts.env?.['ANTHROPIC_API_KEY'] ?? ''
  expect(scrubbedApiKey).not.toBe('mx-oauth-token-1')
})

test('Codex r2 P1 — completion event triggers reportSuccess(pool, id) (consecutive_failures resets)', async () => {
  const pool = newCredentialPool({
    strategy: 'fill_first',
    credentials: [{ id: 'k1', kind: 'api_key', secret: 'sk-test-1' }],
  })
  // Pre-load a failure so we can observe reportSuccess clearing it.
  reportFailure(pool, 'k1', 401)
  expect(pool.credentials[0]!.consecutive_failures).toBe(1)
  expect(pool.credentials[0]!.cooldown_until).toBeDefined()
  // After cooldown clears (simulate via direct mutation rather than
  // sleeping 5min) the next start should succeed AND reportSuccess.
  delete pool.credentials[0]!.cooldown_until
  delete pool.credentials[0]!.cooldown_reason
  const { substrateFactory } = captureFactory()
  const sub = buildImportSubstrate({
    pool,
    substrate_instance_id: 'cc',
    cwd: workdir,
    substrateFactory,
  })
  const h = sub!.start(runSpec())
  for await (const _ev of h.events) {
    // drain
  }
  // After completion → reportSuccess → consecutive_failures cleared.
  expect(pool.credentials[0]!.consecutive_failures).toBe(0)
})

test('Codex r2 P1 — rate_limit error from the substrate calls reportFailure(pool, id, 429)', async () => {
  const pool = newCredentialPool({
    strategy: 'fill_first',
    credentials: [
      { id: 'k1', kind: 'api_key', secret: 'sk-test-1' },
      { id: 'k2', kind: 'api_key', secret: 'sk-test-2' },
    ],
  })
  // First spawn yields a rate_limit error event. parseHttpStatusFromMessage
  // returns null (no `HTTP N:` prefix), so it falls into
  // mapStatusForPoolCooldown(null, retryable=true) → 429 → reportFailure(k1, 429).
  const cap = captureFactory()
  cap.emitError({ retryable: true })
  const sub = buildImportSubstrate({
    pool,
    substrate_instance_id: 'cc',
    cwd: workdir,
    substrateFactory: cap.substrateFactory,
  })
  // First start hits k1 → rate_limit error → cooldown set on k1.
  const h1 = sub!.start(runSpec())
  for await (const _ev of h1.events) {
    // drain
  }
  expect(pool.credentials[0]!.cooldown_reason).toBe('rate_limit_429')
  expect(pool.credentials[0]!.cooldown_until).toBeDefined()
  // Second start MUST skip k1 (in cooldown) → picks k2.
  const cap2 = captureFactory()
  const sub2 = buildImportSubstrate({
    pool,
    substrate_instance_id: 'cc',
    cwd: workdir,
    substrateFactory: cap2.substrateFactory,
  })
  const h2 = sub2!.start(runSpec())
  for await (const _ev of h2.events) {
    // drain
  }
  expect(cap2.seen[0]!.opts.env?.['ANTHROPIC_API_KEY']).toBe('sk-test-2')
})

test.skip('Codex r2 P1 — HTTP 401 error from substrate triggers auth_401 cooldown (parses HTTP <N>: prefix)', () => {
  // auth_401 cooldown unreachable via the CC substrate — `claude` binary
  // owns auth; if its own auth fails the user-visible error is a
  // different shape (no HTTP-401 surface), so the pool's auth_401
  // cooldown is now unreachable from this path. Restored if/when an
  // instance-facing auth-failure surface is added back.
})

test('Codex r4 P1 — overloaded (retryable 5xx-equivalent) error triggers rate_limit_429-class cooldown so multi-key rotation actually fires', async () => {
  const pool = newCredentialPool({
    strategy: 'fill_first',
    credentials: [
      { id: 'k1', kind: 'api_key', secret: 'sk-test-1' },
      { id: 'k2', kind: 'api_key', secret: 'sk-test-2' },
    ],
  })
  // A retryable (overloaded / 5xx-equivalent) error event →
  // mapStatusForPoolCooldown(null, retryable=true) → 429-class cooldown.
  // Without r4's mapping a non-cooldown reportFailure would keep re-serving k1.
  const cap = captureFactory()
  cap.emitError({ retryable: true, message: 'upstream 500 overloaded' })
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
  // ASSERT — k1 got a cooldown clocked (NOT just consecutive_failures++).
  expect(pool.credentials[0]!.cooldown_until).toBeDefined()
  expect(pool.credentials[0]!.cooldown_reason).toBe('rate_limit_429')
  // ASSERT — the next start() rotates to k2 (k1 is parked).
  const cap2 = captureFactory()
  const sub2 = buildImportSubstrate({
    pool,
    substrate_instance_id: 'cc',
    cwd: workdir,
    substrateFactory: cap2.substrateFactory,
  })
  const h2 = sub2!.start(runSpec())
  for await (const _ev of h2.events) {
    // drain
  }
  expect(cap2.seen[0]!.opts.env?.['ANTHROPIC_API_KEY']).toBe('sk-test-2')
})

test('Codex r5 P1 — request-level (non-retryable) error does NOT cool down the credential', async () => {
  const pool = newCredentialPool({
    strategy: 'fill_first',
    credentials: [
      { id: 'k1', kind: 'api_key', secret: 'sk-test-1' },
      { id: 'k2', kind: 'api_key', secret: 'sk-test-2' },
    ],
  })
  // A non-retryable request-level error (e.g. input too long) →
  // mapStatusForPoolCooldown(null, retryable=false) → null → skips
  // reportFailure. selectCredential under fill_first continues to hand back k1.
  const cap = captureFactory()
  cap.emitError({ retryable: false, message: 'input too long' })
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
  // ASSERT — k1 was NOT parked AND consecutive_failures was NOT bumped. A
  // request-level error is request-shape, not credential-shape; the wrapper
  // skips reportFailure entirely so a healthy key isn't punished.
  expect(pool.credentials[0]!.cooldown_until).toBeUndefined()
  expect(pool.credentials[0]!.consecutive_failures).toBe(0)
})

test('2026-06-17 import-blocker — spawn ENOENT (claude not on PATH) is FATAL, NOT a cooldown: no reportFailure, re-emitted as a distinct non-retryable error', async () => {
  const pool = newCredentialPool({
    strategy: 'fill_first',
    credentials: [{ id: 'k1', kind: 'api_key', secret: 'sk-test-1' }],
  })
  // The CC adapter surfaces a missing-binary spawn failure as a RETRYABLE error
  // (persistent-repl-substrate's spawn-catch pushes retryable:true). Pre-fix
  // that laundered into a 429 pool cooldown → next chunk's selectCredential
  // returned null → "all credentials in cooldown" + a retry-after hint → the
  // runner waited + retried forever on a binary that never appears. It MUST
  // instead skip the cooldown and re-emit fatally.
  const cap = captureFactory()
  cap.emitError({ retryable: true, message: 'Executable not found in $PATH: "claude"' })
  const sub = buildImportSubstrate({
    pool,
    substrate_instance_id: 'cc',
    cwd: workdir,
    substrateFactory: cap.substrateFactory,
  })
  const h = sub!.start(runSpec())
  const events: Event[] = []
  for await (const ev of h.events) events.push(ev)
  // The pool was NOT cooled (a missing binary never recovers by waiting).
  expect(pool.credentials[0]!.cooldown_until).toBeUndefined()
  expect(pool.credentials[0]!.consecutive_failures).toBe(0)
  // The error was re-emitted as a distinct, fatal, actionable message — NOT the
  // generic "all credentials in cooldown" — and carries NO retry-after hint, so
  // the import runner classifies it non-retryable and fails fast + loud.
  const err = events.find((e) => e.kind === 'error')
  expect(err).toBeDefined()
  expect(err!.kind === 'error' && err!.retryable).toBe(false)
  expect(err!.kind === 'error' && /not found on the server PATH/i.test(err!.message)).toBe(true)
  expect(err!.kind === 'error' && /cooldown/i.test(err!.message)).toBe(false)
  expect(err!.kind === 'error' && err!.retry_after_ms === undefined).toBe(true)
})

test('Codex r5 P1 — Max OAuth refresh is called on every start() (token freshness across long-lived gateway)', async () => {
  const pool = newCredentialPool({
    strategy: 'fill_first',
    credentials: [{ id: 'm1', kind: 'oauth', secret: 'stale-boot-token' }],
  })
  const refreshCalls: string[] = []
  let tokenCounter = 0
  const oauthRefresh = {
    async loadAccessToken(internal_handle: string) {
      refreshCalls.push(internal_handle)
      tokenCounter += 1
      return { access_token: `fresh-token-${tokenCounter}`, expires_at: Date.now() + 3600_000 }
    },
  }
  const { substrateFactory, seen } = captureFactory()
  const sub = buildImportSubstrate({
    pool,
    substrate_instance_id: 'cc',
    cwd: workdir,
    substrateFactory,
    oauthRefresh,
    internal_handle: 't-casey-0001',
  })
  // Drive two start() calls — assert the refresher is called BOTH times
  // and each call uses the FRESH token (not the stale boot-time secret).
  for (let i = 0; i < 2; i++) {
    const h = sub!.start(runSpec())
    for await (const _ev of h.events) {
      // drain
    }
  }
  expect(refreshCalls.length).toBe(2)
  expect(refreshCalls).toEqual(['t-casey-0001', 't-casey-0001'])
  // First call → CLAUDE_CODE_OAUTH_TOKEN='fresh-token-1'; second →
  // CLAUDE_CODE_OAUTH_TOKEN='fresh-token-2'. Raw token (no Bearer prefix).
  expect(seen[0]!.opts.env?.['CLAUDE_CODE_OAUTH_TOKEN']).toBe('fresh-token-1')
  expect(seen[1]!.opts.env?.['CLAUDE_CODE_OAUTH_TOKEN']).toBe('fresh-token-2')
  // The stale boot-time secret never appears on the wire.
  expect(seen[0]!.opts.env?.['CLAUDE_CODE_OAUTH_TOKEN']).not.toBe('stale-boot-token')
})

test('Codex r5 P1 — oauthRefresh returning null falls back to cached pool secret (revoked/refresh-down path)', async () => {
  const pool = newCredentialPool({
    strategy: 'fill_first',
    credentials: [{ id: 'm1', kind: 'oauth', secret: 'cached-token-1' }],
  })
  const oauthRefresh = {
    async loadAccessToken(): Promise<null> {
      return null
    },
  }
  const { substrateFactory, seen } = captureFactory()
  const sub = buildImportSubstrate({
    pool,
    substrate_instance_id: 'cc',
    cwd: workdir,
    substrateFactory,
    oauthRefresh,
    internal_handle: 't-casey-0001',
  })
  const h = sub!.start(runSpec())
  for await (const _ev of h.events) {
    // drain
  }
  expect(seen[0]!.opts.env?.['CLAUDE_CODE_OAUTH_TOKEN']).toBe('cached-token-1')
})

test('Codex r5 P1 — oauthRefresh throwing surfaces a substrate error event (caller sees the failure)', async () => {
  const pool = newCredentialPool({
    strategy: 'fill_first',
    credentials: [{ id: 'm1', kind: 'oauth', secret: 'cached-token-1' }],
  })
  const oauthRefresh = {
    async loadAccessToken(): Promise<never> {
      throw new Error('refresh endpoint 503')
    },
  }
  const { substrateFactory } = captureFactory()
  const sub = buildImportSubstrate({
    pool,
    substrate_instance_id: 'cc',
    cwd: workdir,
    substrateFactory,
    oauthRefresh,
    internal_handle: 't-casey-0001',
  })
  const h = sub!.start(runSpec())
  const events = []
  for await (const ev of h.events) {
    events.push(ev)
  }
  // Stream surfaces a single error event; no completion fires.
  expect(events.length).toBe(1)
  expect(events[0]!.kind).toBe('error')
  if (events[0]!.kind === 'error') {
    expect(events[0]!.message).toContain('refresh endpoint 503')
  }
})

test('Codex r2 P1 — non-HTTP retryable error falls back to 429-class cooldown', async () => {
  const pool = newCredentialPool({
    strategy: 'fill_first',
    credentials: [{ id: 'k1', kind: 'api_key', secret: 'sk-test-1' }],
  })
  // A retryable error with no `HTTP N:` prefix → parseHttpStatusFromMessage
  // null → mapStatusForPoolCooldown(null, retryable=true) → 429-class cooldown.
  const cap = captureFactory()
  cap.emitError({ retryable: true, message: 'subprocess exited via SIGTERM' })
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
})

test.skip('Codex P1 — claude_home routes transcript writes into the supplied instance-owned dir', () => {
  // claude_home routing dropped — `claude` binary owns transcript path
  // at `~/.claude/projects/<encoded-cwd>/<session_id>.jsonl`; project
  // isolation is a follow-up sprint. The `claude_home` field was
  // removed from BuildImportSubstrateInput entirely.
})

// ─────────────────────────────────────────────────────────────────────────────
// S13 (2026-05-16) — lazy `resolvePool` regression suite
//
// Bug A: pre-S13, the composer skipped wiring importSubstrate when
// `anthropic === null` at boot time. A fresh instance whose `.env` landed
// between composer boot and the first import (synthetic-auth race) hit
// a runner with no substrate and every import failed with "pass1Llm is
// not wired — refusing to run an import" for the lifetime of that
// process. Incident of record: v0.1.34 prod walkthrough.
//
// These tests assert the new lazy-resolution contract:
//
//   1. Construction succeeds even when the resolver returns null at boot.
//   2. Each `start()` call re-runs the resolver.
//   3. A resolver that returns null at dispatch yields a clear error event.
//   4. A resolver that returns null at boot but resolves on retry succeeds.
//   5. Exactly-one validation: supplying both `pool` and `resolvePool`
//      throws; supplying neither throws.
// ─────────────────────────────────────────────────────────────────────────────

test('S13 — lazy resolvePool: construction succeeds when resolver returns null at boot', () => {
  const sub = buildImportSubstrate({
    resolvePool: async () => null,
    substrate_instance_id: 'cc',
    cwd: workdir,
  })
  // Critical contract: never returns null for the lazy path — the
  // dispatch-time resolver is the decision point now, not construction.
  expect(sub).not.toBeNull()
})

test('S13 — lazy resolvePool: dispatch-time null resolution yields a credentials-missing error event', async () => {
  const sub = buildImportSubstrate({
    resolvePool: async () => null,
    substrate_instance_id: 'cc',
    cwd: workdir,
  })
  const h = sub!.start(runSpec())
  const events: Event[] = []
  for await (const ev of h.events) {
    events.push(ev)
  }
  const err = events.find((e) => e.kind === 'error')
  expect(err).toBeDefined()
  expect(err!.kind === 'error' && /no anthropic credentials/i.test(err!.message)).toBe(true)
  expect(err!.kind === 'error' && err!.retryable).toBe(false)
})

test('S13 — lazy resolvePool: re-runs the resolver on EVERY start() call (picks up creds added between dispatches)', async () => {
  // The core Bug A regression: an instance where the resolver returns null
  // at boot but starts returning a valid pool a few seconds later (the
  // synthetic-auth .env race + the Max OAuth attach mid-session both
  // produce this shape). Production MUST re-resolve every dispatch.
  let resolveCount = 0
  let credsAvailable = false
  const resolver = async (): Promise<CredentialPool | null> => {
    resolveCount += 1
    if (!credsAvailable) return null
    return newCredentialPool({
      strategy: 'fill_first',
      credentials: [{ id: 'k1', kind: 'api_key', secret: 'sk-deferred' }],
    })
  }
  const { substrateFactory, seen } = captureFactory()
  const sub = buildImportSubstrate({
    resolvePool: resolver,
    substrate_instance_id: 'cc',
    cwd: workdir,
    substrateFactory,
  })
  expect(sub).not.toBeNull()
  // Attempt 1 — creds still missing. Resolver should fire, return null,
  // and we should see a credentials-missing error event.
  const h1 = sub!.start(runSpec())
  const ev1: Event[] = []
  for await (const ev of h1.events) ev1.push(ev)
  expect(resolveCount).toBe(1)
  expect(ev1.some((e) => e.kind === 'error' && /no anthropic credentials/i.test(e.message))).toBe(true)
  expect(seen.length).toBe(0) // no upstream call attempted

  // Attempt 2 — creds become available (this simulates `.env` landing
  // between dispatches). Resolver MUST be re-invoked; this dispatch
  // should succeed and exercise the upstream spawn with the new secret.
  credsAvailable = true
  const h2 = sub!.start(runSpec())
  for await (const _ev of h2.events) {
    // drain
  }
  expect(resolveCount).toBe(2)
  expect(seen.length).toBe(1)
  expect(seen[0]!.opts.env?.['ANTHROPIC_API_KEY']).toBe('sk-deferred')
})

test('S13 — lazy resolvePool: empty-pool resolution at dispatch is treated as no-creds (not silent success)', async () => {
  // Defense-in-depth: a resolver that returns a pool with `credentials:
  // []` (a stale Max OAuth that got purged, an env var that was unset
  // mid-flight) should hit the same credentials-missing error path as
  // `null`, not surface a misleading "all in cooldown" message.
  const sub = buildImportSubstrate({
    resolvePool: async () =>
      newCredentialPool({ strategy: 'fill_first', credentials: [] }),
    substrate_instance_id: 'cc',
    cwd: workdir,
  })
  expect(sub).not.toBeNull()
  const h = sub!.start(runSpec())
  const events: Event[] = []
  for await (const ev of h.events) events.push(ev)
  const err = events.find((e) => e.kind === 'error')
  expect(err).toBeDefined()
  expect(err!.kind === 'error' && /no anthropic credentials/i.test(err!.message)).toBe(true)
})

test('S13 — exactly-one validation: supplying both `pool` and `resolvePool` throws at construction', () => {
  const pool = newCredentialPool({
    strategy: 'fill_first',
    credentials: [{ id: 'k1', kind: 'api_key', secret: 'sk' }],
  })
  expect(() =>
    buildImportSubstrate({
      pool,
      resolvePool: async () => pool,
      substrate_instance_id: 'cc',
      cwd: workdir,
    }),
  ).toThrow(/cannot supply BOTH/i)
})

test('S13 — exactly-one validation: supplying neither `pool` nor `resolvePool` throws at construction', () => {
  expect(() =>
    buildImportSubstrate({
      substrate_instance_id: 'cc',
      cwd: workdir,
    } as Parameters<typeof buildImportSubstrate>[0]),
  ).toThrow(/exactly one of/i)
})

// --- RESOLVER PRECEDENCE (audit round 13): same fix on the import path — an
// EMPTY/whitespace providerResolver result defers to the static `provider`. ---

function importAnthropicPool(): CredentialPool {
  return newCredentialPool({ strategy: 'fill_first', credentials: [{ id: 'anthropic:k', kind: 'api_key', secret: 'sk-ant' }] })
}
function importOpenaiPool(): CredentialPool {
  return newCredentialPool({ strategy: 'fill_first', credentials: [{ id: 'openai:k', kind: 'api_key', secret: 'sk-openai' }] })
}
function importGptFetch(): typeof fetch {
  const sse =
    [
      { event: 'response.created', data: { type: 'response.created', response: { id: 'r1' } } },
      { event: 'response.completed', data: { type: 'response.completed', response: { id: 'r1', usage: { input_tokens: 1, output_tokens: 1 } } } },
    ]
      .map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n`)
      .join('\n') + '\n'
  return (async () => {
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close() } })
    return new Response(stream, { status: 200 })
  }) as unknown as typeof fetch
}
async function drainImport(h: SessionHandle): Promise<Event[]> {
  const out: Event[] = []
  for await (const e of h.events) out.push(e)
  return out
}

test("import RESOLVER '' + static provider:'openai' → openai path (NOT a silent Claude fallback)", async () => {
  const { substrateFactory, seen } = captureFactory()
  const sub = buildImportSubstrate({
    pool: importAnthropicPool(),
    substrate_instance_id: 'cc-import-x',
    provider: 'openai',
    providerResolver: () => '',
    substrateFactory,
    openai: { pool: importOpenaiPool(), bindMcpResolver: () => async () => ({}), model_preference: ['gpt-5.6'], fetchImpl: importGptFetch() },
  })!
  const events = await drainImport(sub.start(runSpec()))
  expect(seen).toHaveLength(0) // CC fake NOT called → openai path
  expect(events.some((e) => e.kind === 'completion')).toBe(true)
})

test("import RESOLVER 'openai' (non-empty) + static provider:'anthropic' → resolver wins → openai path", async () => {
  const { substrateFactory, seen } = captureFactory()
  const sub = buildImportSubstrate({
    pool: importAnthropicPool(),
    substrate_instance_id: 'cc-import-y',
    provider: 'anthropic',
    providerResolver: () => 'openai',
    substrateFactory,
    openai: { pool: importOpenaiPool(), bindMcpResolver: () => async () => ({}), model_preference: ['gpt-5.6'], fetchImpl: importGptFetch() },
  })!
  const events = await drainImport(sub.start(runSpec()))
  expect(seen).toHaveLength(0)
  expect(events.some((e) => e.kind === 'completion')).toBe(true)
})

test("import RESOLVER '' + absent static provider → Claude default (byte-identical)", async () => {
  const { substrateFactory, seen } = captureFactory()
  const sub = buildImportSubstrate({
    pool: importAnthropicPool(),
    substrate_instance_id: 'cc-import-z',
    providerResolver: () => '',
    substrateFactory,
  })!
  await drainImport(sub.start(runSpec()))
  expect(seen).toHaveLength(1) // truly-absent → Claude default
})
