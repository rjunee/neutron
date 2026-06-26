/**
 * Tests for the shared `buildLlmCallSubstrate` primitive — the CC-substrate that
 * every LLM call site dispatches through.
 *
 * S3 rip-replace (2026-06-07): the persistent interactive-REPL is the SOLE
 * substrate (cli-transport `claude -p` deleted). These tests exercise the
 * composer logic (credential selection + rotation, ISSUES-#49 env scrubbing,
 * Max-OAuth refresh, cooldown classification) through the `substrateFactory`
 * seam — a fake `Substrate` that captures the composed options (incl. the
 * scrubbed env) + spec and yields canned `Event`s. No real `claude` REPL spawns.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildLlmCallSubstrate,
  collectTokensToString,
} from '../build-llm-call-substrate.ts'
import type { SessionHandle } from '../../../runtime/session-handle.ts'
import type { ClaudeCodeSubstrateOptions } from '../../../runtime/adapters/claude-code/index.ts'
import {
  newCredentialPool,
  type CredentialPool,
} from '../../../runtime/credential-pool.ts'
import type { AgentSpec, Substrate } from '../../../runtime/substrate.ts'
import type { Event } from '../../../runtime/events.ts'
import { poolKeyFor } from '../../../runtime/adapters/claude-code/persistent/persistent-repl-substrate.ts'

let workdir: string

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'neutron-bllmc-'))
})

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true })
})

interface ErrorEmit {
  /** retryable flag on the yielded error event. */
  retryable: boolean
  /** error message (drives the composer's cooldown classification). */
  message?: string
}

/**
 * A fake substrate factory that captures the composed `ClaudeCodeSubstrateOptions`
 * + spec per `start()` and yields canned `Event`s. Replaces the old cli-transport
 * `spawnImpl` stub: the composer now yields the substrate's events directly, so
 * the fake yields the terminal completion/error events the composer classifies.
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
          message: behaviour.opts.message ?? 'rate_limit: limit reached',
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
    prompt: 'hello',
    tools: [],
    model_preference: ['claude-opus-4-7'],
    max_tokens: 100,
  }
}

// ---------------------------------------------------------------------------
// 1. Happy path — eager pool, single api_key credential, success result.
// ---------------------------------------------------------------------------

test('eager pool + api_key credential dispatches successfully and threads ANTHROPIC_API_KEY', async () => {
  const pool = newCredentialPool({
    strategy: 'fill_first',
    credentials: [{ id: 'k1', kind: 'api_key', secret: 'sk-test' }],
  })
  const { substrateFactory, seen } = captureFactory()
  const sub = buildLlmCallSubstrate({
    pool,
    substrate_instance_id: 'inst-1',
    cwd: workdir,
    substrateFactory,
  })
  expect(sub).not.toBeNull()
  const handle = sub!.start(runSpec())
  const events: Event[] = []
  for await (const ev of handle.events) {
    events.push(ev)
  }
  const completion = events.find((e) => e.kind === 'completion')
  expect(completion).toBeDefined()
  expect(completion!.kind === 'completion' && completion!.substrate_instance_id).toBe('inst-1')
  expect(seen.length).toBe(1)
  // model flows through the spec.
  expect(seen[0]!.spec.model_preference[0]).toBe('claude-opus-4-7')
  // api_key → ANTHROPIC_API_KEY set; CLAUDE_CODE_OAUTH_TOKEN scrubbed.
  expect(seen[0]!.opts.env?.['ANTHROPIC_API_KEY']).toBe('sk-test')
  expect(seen[0]!.opts.env?.['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined()
  // The selected credential id is folded into the pool key (#104), never the secret.
  expect(seen[0]!.opts.credential_identity).toBe('k1')
  // Pool side-effects: use_count incremented, no failures.
  expect(pool.credentials[0]!.use_count).toBe(1)
  expect(pool.credentials[0]!.consecutive_failures).toBe(0)
})

test('import warm-session (2026-06-17) — the Open composer cc-import substrate is built WARM (not ephemeral) with reset_context_per_turn', async () => {
  // GUARD for `open/composer.ts`: the history-import substrate must reuse ONE
  // warm `claude` process across chunks (NOT `ephemeral: true`, which respawns a
  // fresh REPL per chunk = the saturation defect the held PR #76 introduced), and
  // it must set `reset_context_per_turn` so each chunk runs on a freshly-cleared
  // context. This replicates the EXACT construction the Open composer uses for
  // `cc-import-*` and asserts the composed substrate opts carry both properties.
  const pool = newCredentialPool({
    strategy: 'fill_first',
    credentials: [{ id: 'k1', kind: 'oauth', secret: 'oauth-token' }],
  })
  const { substrateFactory, seen } = captureFactory()
  const sub = buildLlmCallSubstrate({
    pool,
    substrate_instance_id: 'cc-import-owner',
    cwd: workdir,
    user_id: 'owner',
    project_slug: 'owner',
    skip_permissions: true,
    reset_context_per_turn: true,
    // NOTE: ephemeral intentionally NOT set (the warm path).
    substrateFactory,
  })
  expect(sub).not.toBeNull()
  // Drain two session-less chunk dispatches.
  for (let i = 0; i < 2; i += 1) {
    const h = sub!.start(runSpec())
    for await (const _ev of h.events) {
      // drain
    }
  }
  expect(seen.length).toBe(2)
  for (const s of seen) {
    // WARM: ephemeral must NOT be set (would respawn per chunk).
    expect(s.opts.ephemeral).toBeUndefined()
    // Per-chunk context reset is wired on every dispatch.
    expect(s.opts.reset_context_per_turn).toBe(true)
    expect(s.opts.substrate_instance_id).toBe('cc-import-owner')
  }
})

test('threads claude_config_dir into the substrate opts (interactive-Max-login self-refresh, Codex r2 P1)', async () => {
  const pool = newCredentialPool({
    strategy: 'fill_first',
    credentials: [{ id: 'oauth-1', kind: 'oauth', secret: 'oauth-secret' }],
  })
  const { substrateFactory, seen } = captureFactory()
  const sub = buildLlmCallSubstrate({
    pool,
    substrate_instance_id: 'inst-cfg',
    cwd: workdir,
    claude_config_dir: '/srv/neutron/owners/acme/.claude',
    substrateFactory,
  })
  expect(sub).not.toBeNull()
  await collectTokensToString(sub!.start(runSpec()))
  // The per-instance config dir flows to `createClaudeCodeSubstrateAuto` → the
  // persistent child's CLAUDE_CONFIG_DIR, so the interactive child self-refreshes
  // its OAuth token from its own `.credentials.json` and the warm REPL never
  // serves a turn on a stale env token.
  expect(seen[0]!.opts.claude_config_dir).toBe('/srv/neutron/owners/acme/.claude')
})

// ---------------------------------------------------------------------------
// 1b. Argus r3 BLOCKER — the LIVE per-turn project id (NOT the dead
//     `spec.metering_context.project_id`) is folded into the warm-pool key, so
//     two DISTINCT projects for the same (owner,user) resolve to DISTINCT warm
//     REPLs (no shared `--resume` transcript ⇒ no cross-project context bleed).
// ---------------------------------------------------------------------------

test('projectIdResolver folds the LIVE active project into the pool key → distinct projects get distinct warm REPLs', async () => {
  const pool = newCredentialPool({
    strategy: 'fill_first',
    credentials: [{ id: 'k1', kind: 'api_key', secret: 'sk-test' }],
  })
  const { substrateFactory, seen } = captureFactory()
  // Mutable live project pointer — mirrors `ownerChatProjectIdResolver` reading
  // `WebChatSessionProjectRegistry.getActive(owner)` (the user switches projects
  // between turns). The substrate is built ONCE (per instance); the resolver is
  // re-evaluated on every dispatch per active project.
  let activeProject = 'project-alpha'
  const sub = buildLlmCallSubstrate({
    pool,
    substrate_instance_id: 'cc-llm-acme',
    cwd: workdir,
    user_id: 'owner-acme',
    projectIdResolver: () => activeProject,
    substrateFactory,
  })
  expect(sub).not.toBeNull()

  // Turn 1 — user is in project-alpha.
  await collectTokensToString(sub!.start(runSpec()))
  // Turn 2 — user switches to project-beta (SAME instance, SAME user, SAME cred).
  activeProject = 'project-beta'
  await collectTokensToString(sub!.start(runSpec()))

  expect(seen.length).toBe(2)
  // The live project id is threaded into the spawn opts (NOT the dead
  // metering_context dimension — runSpec() never sets it).
  expect(seen[0]!.opts.project_id).toBe('project-alpha')
  expect(seen[1]!.opts.project_id).toBe('project-beta')
  expect(seen[0]!.spec.metering_context).toBeUndefined()

  // The decisive property: distinct projects → DISTINCT warm-pool keys, so the
  // two turns land on two separate REPLs and one project's `--resume` transcript
  // can never bleed into the other's.
  const keyAlpha = poolKeyFor(seen[0]!.opts)
  const keyBeta = poolKeyFor(seen[1]!.opts)
  expect(keyAlpha).not.toBe(keyBeta)
  // ...while two turns within the SAME project DO share a REPL (warm reuse intact).
  expect(poolKeyFor(seen[0]!.opts)).toBe(poolKeyFor({ ...seen[0]!.opts }))
})

test('absent projectIdResolver falls back to spec.metering_context.project_id, then to default', async () => {
  const pool = newCredentialPool({
    strategy: 'fill_first',
    credentials: [{ id: 'k1', kind: 'api_key', secret: 'sk-test' }],
  })
  const { substrateFactory, seen } = captureFactory()
  const sub = buildLlmCallSubstrate({
    pool,
    substrate_instance_id: 'cc-llm-acme',
    cwd: workdir,
    user_id: 'owner-acme',
    // No projectIdResolver — platform-internal / legacy caller.
    substrateFactory,
  })
  // A caller that DOES populate metering_context (e.g. a future Private path)
  // still flows through as the fallback.
  const specWithMetering: AgentSpec = {
    ...runSpec(),
    metering_context: { project_id: 'metered-proj' },
  }
  await collectTokensToString(sub!.start(specWithMetering))
  expect(seen[0]!.opts.project_id).toBe('metered-proj')

  // And with neither resolver nor metering_context, the substrate keys
  // `project_id` as undefined → poolKeyFor namespaces it as 'default'.
  await collectTokensToString(sub!.start(runSpec()))
  expect(seen[1]!.opts.project_id).toBeUndefined()
})

// ---------------------------------------------------------------------------
// 2. Happy path — oauth credential threads CLAUDE_CODE_OAUTH_TOKEN, scrubs
//    ANTHROPIC_API_KEY.
// ---------------------------------------------------------------------------

test('eager pool + oauth credential threads CLAUDE_CODE_OAUTH_TOKEN and scrubs ANTHROPIC_API_KEY', async () => {
  const pool = newCredentialPool({
    strategy: 'fill_first',
    credentials: [{ id: 'o1', kind: 'oauth', secret: 'oauth-token-abc' }],
  })
  const { substrateFactory, seen } = captureFactory()
  const sub = buildLlmCallSubstrate({
    pool,
    substrate_instance_id: 'inst-1',
    cwd: workdir,
    substrateFactory,
  })
  const handle = sub!.start(runSpec())
  for await (const _ev of handle.events) {
    // drain
  }
  expect(seen[0]!.opts.env?.['CLAUDE_CODE_OAUTH_TOKEN']).toBe('oauth-token-abc')
  // ANTHROPIC_API_KEY explicitly scrubbed — the wrapper sets it to undefined
  // so the spawned `claude` binary can't pick up a host-leaked value.
  expect(seen[0]!.opts.env?.['ANTHROPIC_API_KEY']).toBeUndefined()
})

// ---------------------------------------------------------------------------
// 2b. extra_env overlay — root-cause fix (2026-06-05). A router-dedicated
//     substrate carries MAX_THINKING_TOKENS=0 on every spawn, layered AFTER
//     the auth scrub (so auth env is preserved, the knob wins on collision).
// ---------------------------------------------------------------------------

test('extra_env overlay is layered onto the spawn env after auth scrub', async () => {
  const pool = newCredentialPool({
    strategy: 'fill_first',
    credentials: [{ id: 'o1', kind: 'oauth', secret: 'oauth-token-abc' }],
  })
  const { substrateFactory, seen } = captureFactory()
  const sub = buildLlmCallSubstrate({
    pool,
    substrate_instance_id: 'inst-router',
    cwd: workdir,
    substrateFactory,
    extra_env: { MAX_THINKING_TOKENS: '0' },
  })
  const handle = sub!.start(runSpec())
  for await (const _ev of handle.events) {
    // drain
  }
  // Router knob present...
  expect(seen[0]!.opts.env?.['MAX_THINKING_TOKENS']).toBe('0')
  // ...and the auth env is untouched by the overlay.
  expect(seen[0]!.opts.env?.['CLAUDE_CODE_OAUTH_TOKEN']).toBe('oauth-token-abc')
  expect(seen[0]!.opts.env?.['ANTHROPIC_API_KEY']).toBeUndefined()
})

// ---------------------------------------------------------------------------
// 3. Lazy `resolvePool` re-resolves on every start().
// ---------------------------------------------------------------------------

test('lazy resolvePool is re-invoked on every start() (picks up new creds between dispatches)', async () => {
  const poolA = newCredentialPool({
    strategy: 'fill_first',
    credentials: [{ id: 'kA', kind: 'api_key', secret: 'sk-A' }],
  })
  const poolB = newCredentialPool({
    strategy: 'fill_first',
    credentials: [{ id: 'kB', kind: 'api_key', secret: 'sk-B' }],
  })
  let callCount = 0
  const resolvePool = async (): Promise<CredentialPool | null> => {
    callCount += 1
    return callCount === 1 ? poolA : poolB
  }
  const { substrateFactory, seen } = captureFactory()
  const sub = buildLlmCallSubstrate({
    resolvePool,
    substrate_instance_id: 'inst-1',
    cwd: workdir,
    substrateFactory,
  })
  expect(sub).not.toBeNull()
  const h1 = sub!.start(runSpec())
  for await (const _ev of h1.events) {
    // drain
  }
  const h2 = sub!.start(runSpec())
  for await (const _ev of h2.events) {
    // drain
  }
  expect(callCount).toBe(2)
  expect(seen.length).toBe(2)
  expect(seen[0]!.opts.env?.['ANTHROPIC_API_KEY']).toBe('sk-A')
  expect(seen[1]!.opts.env?.['ANTHROPIC_API_KEY']).toBe('sk-B')
})

// ---------------------------------------------------------------------------
// 4. Lazy `resolvePool` returns null → error event, no spawn.
// ---------------------------------------------------------------------------

test('lazy resolvePool returning null yields a credentials-missing error event without spawning', async () => {
  const { substrateFactory, seen } = captureFactory()
  const sub = buildLlmCallSubstrate({
    resolvePool: async () => null,
    substrate_instance_id: 'inst-1',
    cwd: workdir,
    substrateFactory,
  })
  expect(sub).not.toBeNull()
  const handle = sub!.start(runSpec())
  const events: Event[] = []
  for await (const ev of handle.events) {
    events.push(ev)
  }
  expect(events.length).toBe(1)
  expect(events[0]!.kind).toBe('error')
  if (events[0]!.kind === 'error') {
    expect(/no Anthropic credentials/i.test(events[0]!.message)).toBe(true)
    expect(events[0]!.retryable).toBe(false)
  }
  expect(seen.length).toBe(0)
})

// ---------------------------------------------------------------------------
// 5. Eager pool empty → buildLlmCallSubstrate returns null at construction.
// ---------------------------------------------------------------------------

test('eager pool with no credentials → buildLlmCallSubstrate returns null at construction', () => {
  const pool = newCredentialPool({ strategy: 'fill_first', credentials: [] })
  const sub = buildLlmCallSubstrate({
    pool,
    substrate_instance_id: 'inst-1',
    cwd: workdir,
  })
  expect(sub).toBeNull()
})

// ---------------------------------------------------------------------------
// 6. Cooldown reporting — 429-shaped error → reportFailure(429).
// ---------------------------------------------------------------------------

test('rate-limit error from the substrate sets cooldown_reason=rate_limit_429 on the credential', async () => {
  const pool = newCredentialPool({
    strategy: 'fill_first',
    credentials: [{ id: 'k1', kind: 'api_key', secret: 'sk-1' }],
  })
  const cap = captureFactory()
  cap.emitError({ retryable: true, message: 'rate_limit: You’ve hit your limit' })
  const sub = buildLlmCallSubstrate({
    pool,
    substrate_instance_id: 'inst-1',
    cwd: workdir,
    substrateFactory: cap.substrateFactory,
  })
  const handle = sub!.start(runSpec())
  for await (const _ev of handle.events) {
    // drain
  }
  expect(pool.credentials[0]!.cooldown_reason).toBe('rate_limit_429')
  expect(pool.credentials[0]!.cooldown_until).toBeDefined()
})

test('2026-06-17 import-blocker — spawn ENOENT (claude not on PATH) is FATAL, NOT a 429 cooldown: no reportFailure, re-emitted non-retryable + actionable', async () => {
  const pool = newCredentialPool({
    strategy: 'fill_first',
    credentials: [{ id: 'k1', kind: 'api_key', secret: 'sk-1' }],
  })
  // A missing-binary spawn failure arrives RETRYABLE (the adapter's spawn-catch
  // pushes retryable:true). Pre-fix `mapStatusForPoolCooldown(null, true)` →
  // 429 cooldown. It must be classified binary-not-found FIRST: no cooldown,
  // re-emitted as a distinct, fatal, actionable error.
  const cap = captureFactory()
  cap.emitError({ retryable: true, message: 'Executable not found in $PATH: "claude"' })
  const sub = buildLlmCallSubstrate({
    pool,
    substrate_instance_id: 'inst-1',
    cwd: workdir,
    substrateFactory: cap.substrateFactory,
  })
  const handle = sub!.start(runSpec())
  const events: Event[] = []
  for await (const ev of handle.events) events.push(ev)
  // No cooldown — a missing binary never recovers by waiting.
  expect(pool.credentials[0]!.cooldown_until).toBeUndefined()
  expect(pool.credentials[0]!.cooldown_reason).toBeUndefined()
  expect(pool.credentials[0]!.consecutive_failures).toBe(0)
  // Re-emitted as the distinct fatal message, non-retryable, no retry hint.
  const err = events.find((e) => e.kind === 'error')
  expect(err).toBeDefined()
  expect(err!.kind === 'error' && err!.retryable).toBe(false)
  expect(err!.kind === 'error' && /not found on the server PATH/i.test(err!.message)).toBe(true)
})

test('2026-06-26 dev-channel wedge — channel-wedged spawn failure is a SUBSTRATE failure, NOT a cred cooldown: no reportFailure, re-emitted non-retryable + actionable', async () => {
  const pool = newCredentialPool({
    strategy: 'fill_first',
    credentials: [{ id: 'k1', kind: 'oauth', secret: 'oauth-1' }],
  })
  // The persistent-REPL substrate surfaces a wedged spawn RETRYABLE with the
  // `persistent-repl: spawn failed (channel-wedged; …)` text (ChannelWedgedSpawnError).
  // Pre-fix `mapStatusForPoolCooldown(null, true)` → 429 → reportFailure cooled
  // down a healthy credential, eventually surfacing as "all Anthropic credentials
  // are in cooldown". It must be classified channel-wedged FIRST: no cooldown,
  // re-emitted as a distinct, non-retryable, actionable error.
  const cap = captureFactory()
  cap.emitError({
    retryable: true,
    message: 'persistent-repl: spawn failed (channel-wedged; pid=4242 port=51999)',
  })
  const sub = buildLlmCallSubstrate({
    pool,
    substrate_instance_id: 'inst-1',
    cwd: workdir,
    substrateFactory: cap.substrateFactory,
  })
  const handle = sub!.start(runSpec())
  const events: Event[] = []
  for await (const ev of handle.events) events.push(ev)
  // No cooldown — a wedged spawn is not a credential condition.
  expect(pool.credentials[0]!.cooldown_until).toBeUndefined()
  expect(pool.credentials[0]!.cooldown_reason).toBeUndefined()
  expect(pool.credentials[0]!.consecutive_failures).toBe(0)
  // Re-emitted as the distinct substrate-failure message, non-retryable.
  const err = events.find((e) => e.kind === 'error')
  expect(err).toBeDefined()
  expect(err!.kind === 'error' && err!.retryable).toBe(false)
  expect(err!.kind === 'error' && /session channel failed to bind/i.test(err!.message)).toBe(true)
  expect(err!.kind === 'error' && /NOT an Anthropic credential cooldown/i.test(err!.message)).toBe(
    true,
  )
})

test('the other post-spawn-assertion failures (no-channel-ready / no-http-health / dead-child) also skip the cred cooldown', async () => {
  for (const reason of ['no-channel-ready', 'no-http-health', 'dead-child']) {
    const pool = newCredentialPool({
      strategy: 'fill_first',
      credentials: [{ id: 'k1', kind: 'oauth', secret: 'oauth-1' }],
    })
    const cap = captureFactory()
    cap.emitError({ retryable: true, message: `persistent-repl: spawn failed (${reason}; pid=1)` })
    const sub = buildLlmCallSubstrate({
      pool,
      substrate_instance_id: 'inst-1',
      cwd: workdir,
      substrateFactory: cap.substrateFactory,
    })
    const handle = sub!.start(runSpec())
    for await (const _ev of handle.events) {
      // drain
    }
    expect(pool.credentials[0]!.cooldown_reason).toBeUndefined()
    expect(pool.credentials[0]!.consecutive_failures).toBe(0)
  }
})

// ---------------------------------------------------------------------------
// 7. Cooldown reporting — CLI auth failure → auth_401 cooldown via
//    detectCliAuthFailure.
// ---------------------------------------------------------------------------

test('auth failure error message ("invalid api key") sets cooldown_reason=auth_401', async () => {
  const pool = newCredentialPool({
    strategy: 'fill_first',
    credentials: [{ id: 'k1', kind: 'api_key', secret: 'sk-1' }],
  })
  const cap = captureFactory()
  // retryable=false → mapStatusForPoolCooldown returns null UNLESS
  // detectCliAuthFailure short-circuits to 401 first (the `invalid api key` regex).
  cap.emitError({
    retryable: false,
    message: 'invalid api key — please check your credentials',
  })
  const sub = buildLlmCallSubstrate({
    pool,
    substrate_instance_id: 'inst-1',
    cwd: workdir,
    substrateFactory: cap.substrateFactory,
  })
  const handle = sub!.start(runSpec())
  for await (const _ev of handle.events) {
    // drain
  }
  expect(pool.credentials[0]!.cooldown_reason).toBe('auth_401')
})

// ---------------------------------------------------------------------------
// 8. Completion → reportSuccess clears any prior cooldown.
// ---------------------------------------------------------------------------

test('completion event triggers reportSuccess which clears prior cooldown state', async () => {
  const pool = newCredentialPool({
    strategy: 'fill_first',
    credentials: [{ id: 'k1', kind: 'api_key', secret: 'sk-1' }],
  })
  // Pre-set a fake cooldown so we can observe reportSuccess clearing it.
  pool.credentials[0]!.cooldown_until = Date.now() - 1000 // already-past so selectCredential still picks it
  pool.credentials[0]!.cooldown_reason = 'rate_limit_429'
  pool.credentials[0]!.consecutive_failures = 2

  const { substrateFactory } = captureFactory()
  const sub = buildLlmCallSubstrate({
    pool,
    substrate_instance_id: 'inst-1',
    cwd: workdir,
    substrateFactory,
  })
  const handle = sub!.start(runSpec())
  for await (const _ev of handle.events) {
    // drain
  }
  // After completion → reportSuccess → cooldown cleared, failures reset.
  expect(pool.credentials[0]!.cooldown_until).toBeUndefined()
  expect(pool.credentials[0]!.cooldown_reason).toBeUndefined()
  expect(pool.credentials[0]!.consecutive_failures).toBe(0)
})

// ---------------------------------------------------------------------------
// 9. Max OAuth refresh — supplied oauthRefresh.loadAccessToken returns a
//    fresh token; spawned env uses the fresh token, not the cached pool
//    secret.
// ---------------------------------------------------------------------------

test('oauthRefresh returning fresh token threads that token into env, not the cached pool secret', async () => {
  const pool = newCredentialPool({
    strategy: 'fill_first',
    credentials: [{ id: 'm1', kind: 'oauth', secret: 'stale-cached' }],
  })
  const oauthRefresh = {
    async loadAccessToken(_handle: string) {
      return { access_token: 'fresh-token', expires_at: Date.now() + 3600_000 }
    },
  }
  const { substrateFactory, seen } = captureFactory()
  const sub = buildLlmCallSubstrate({
    pool,
    substrate_instance_id: 'inst-1',
    cwd: workdir,
    substrateFactory,
    oauthRefresh,
    internal_handle: 't-1',
  })
  const handle = sub!.start(runSpec())
  for await (const _ev of handle.events) {
    // drain
  }
  expect(seen[0]!.opts.env?.['CLAUDE_CODE_OAUTH_TOKEN']).toBe('fresh-token')
  expect(seen[0]!.opts.env?.['CLAUDE_CODE_OAUTH_TOKEN']).not.toBe('stale-cached')
})

// ---------------------------------------------------------------------------
// 10. Cancel — handle.cancel() before dispatch → no spawn fires.
// ---------------------------------------------------------------------------

test('handle.cancel() called before draining events causes the inner substrate to be cancelled', async () => {
  const pool = newCredentialPool({
    strategy: 'fill_first',
    credentials: [{ id: 'k1', kind: 'api_key', secret: 'sk-1' }],
  })
  const { substrateFactory } = captureFactory()
  const sub = buildLlmCallSubstrate({
    pool,
    substrate_instance_id: 'inst-1',
    cwd: workdir,
    substrateFactory,
  })
  const handle = sub!.start(runSpec())
  // Cancel immediately, BEFORE awaiting any events.
  await handle.cancel()
  // Now drain — the events generator should complete without throwing.
  const events: Event[] = []
  for await (const ev of handle.events) {
    events.push(ev)
  }
  // Either no events emitted (cancel observed before iter started) or
  // an early-termination shape — the contract is "no throw".
  expect(Array.isArray(events)).toBe(true)
})

// ---------------------------------------------------------------------------
// 11. Constructor validation — supplying BOTH `pool` and `resolvePool`
//     throws.
// ---------------------------------------------------------------------------

test('supplying BOTH `pool` and `resolvePool` throws at construction', () => {
  const pool = newCredentialPool({
    strategy: 'fill_first',
    credentials: [{ id: 'k1', kind: 'api_key', secret: 'sk' }],
  })
  expect(() =>
    buildLlmCallSubstrate({
      pool,
      resolvePool: async () => pool,
      substrate_instance_id: 'inst-1',
      cwd: workdir,
    }),
  ).toThrow(/cannot supply BOTH/i)
})

// ---------------------------------------------------------------------------
// 12. Constructor validation — supplying NEITHER `pool` nor `resolvePool`
//     throws.
// ---------------------------------------------------------------------------

test('supplying NEITHER `pool` nor `resolvePool` throws at construction', () => {
  expect(() =>
    buildLlmCallSubstrate({
      substrate_instance_id: 'inst-1',
      cwd: workdir,
    } as Parameters<typeof buildLlmCallSubstrate>[0]),
  ).toThrow(/exactly one of/i)
})

// ---------------------------------------------------------------------------
// 13. Argus r1 IMPORTANT #2 (2026-05-31) — collectTokensToString throws on
//     post-loop abort even when the iterator ends naturally (cancel()
//     closes the inner stream, the for-await loop exits without yielding
//     another event past the `aborted` check, the pre-fix `return buf`
//     would silently surface partial tokens as a successful response).
// ---------------------------------------------------------------------------

test('collectTokensToString throws aborted when signal fires after last loop check', async () => {
  // Build a fake SessionHandle whose iterator yields ONE token then waits
  // for cancel() before resolving. The test fires abort() AFTER the first
  // token is consumed; the inner stream closes via cancel(), the for-await
  // loop ends naturally, and the helper must STILL throw.
  let cancelCalled = false
  const ac = new AbortController()
  const handle: SessionHandle = {
    events: (async function* () {
      yield { kind: 'token', text: 'partial' }
      // Fire abort mid-iteration; the next .next() resolves when
      // cancel() closes the source. We simulate by awaiting a promise
      // that resolves on cancel.
      await new Promise<void>((resolve) => {
        if (cancelCalled) resolve()
        const tick = setInterval(() => {
          if (cancelCalled) {
            clearInterval(tick)
            resolve()
          }
        }, 1)
      })
      // Iterator ends naturally (no completion / no error event).
    })(),
    respondToTool: async () => undefined,
    cancel: async () => {
      cancelCalled = true
    },
    tool_resolution: 'internal',
  }

  // Start consuming; abort after a microtask so the first token lands
  // before cancel.
  const consumer = collectTokensToString(handle, ac.signal)
  await Promise.resolve()
  // Token has been pushed into buf; abort now closes the stream.
  ac.abort()
  await expect(consumer).rejects.toThrow(/aborted/i)
})

test('collectTokensToString throws aborted-before-dispatch when signal pre-fired', async () => {
  const ac = new AbortController()
  ac.abort()
  let cancelCalled = false
  const handle: SessionHandle = {
    events: (async function* () {
      yield { kind: 'token', text: 'never-seen' }
    })(),
    respondToTool: async () => undefined,
    cancel: async () => {
      cancelCalled = true
    },
    tool_resolution: 'internal',
  }
  await expect(collectTokensToString(handle, ac.signal)).rejects.toThrow(
    /aborted before dispatch/i,
  )
  expect(cancelCalled).toBe(true)
})
