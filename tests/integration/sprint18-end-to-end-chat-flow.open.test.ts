/**
 * Sprint 18 — end-to-end chat flow integration test (OPEN carve).
 *
 * Walks the full single-owner web chat chain with NO mocks for the
 * gateway HTTP / WebSocket surface — real `Bun.serve`, real Bun WebSocket
 * client, real engine, real start-token verify + claim, real ChatBridge.
 *
 * OPEN carve note: the original imported `issueStartToken` /
 * `verifyStartToken` / `claimStartTokenJti` / `InMemoryConsumedTokens`
 * from the Managed `signup/start-token.ts`. The Open subset of the
 * start-token contract is the structural shape in
 * `@neutronai/runtime/start-token-types.ts` + the in-memory claim store
 * `@neutronai/runtime/consumed-tokens-in-memory.ts`. There is no Open
 * identity service to mint tokens against, so this test mints + verifies
 * start-tokens entirely in-process with a local EdDSA key (jose), exactly
 * the way `jwt-validator/__tests__` mints local access tokens. The minted
 * tokens carry the production wire shape (claims `instance_slug`,
 * `signup_via`, `sub`, `aud: ['neutron-onboarding-start']`, `jti`), so the
 * production chat-bridge verifier injected here exercises the real
 * signature / audience / channel-scoping checks.
 *
 * Flow exercised:
 *   1. Boot platform-landing on port:0 with mock identityOauthUrl.
 *      `GET /api/v1/sign-up?via=web` returns a 302 to that URL.
 *   2. Mint a web-typed start-token for the single owner instance
 *      (slug=alice, user=u-1) locally.
 *   3. Boot a per-owner gateway with:
 *        - real ProjectDb + migrations
 *        - real ButtonStore + InMemoryOnboardingStateStore
 *        - real InterviewEngine routed via buildRoutedSendButtonPrompt
 *        - createLandingServer with buildWebChatBridge (production bridge)
 *      `GET /chat` returns the chat.html.
 *   4. Open a Bun WebSocket to `ws://...:port/ws/chat?start=<token>`.
 *   5. Assert WS upgraded (no 401), first prompt arrives, state advances.
 *   6. Single-owner auth-scoping: a token minted for a DIFFERENT owner
 *      slug, and a telegram-typed token, are both rejected (401).
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { generateKeyPair, SignJWT, jwtVerify, type JWTPayload, type KeyLike } from 'jose'
import { boot } from '@neutronai/gateway/index.ts'
import { createLandingServer } from '@neutronai/landing/server.ts'
import { bootSignup } from '@neutronai/landing/boot.ts'
import {
  buildRoutedSendButtonPrompt,
  buildWebChatBridge,
  InMemoryWebChatSenderRegistry,
} from '@neutronai/gateway/http/chat-bridge.ts'
import { ButtonStore } from '@neutronai/channels/button-store.ts'
import { InterviewEngine } from '@neutronai/onboarding/interview/engine.ts'
import { STATIC_PHASE_SPECS } from '@neutronai/onboarding/interview/phase-prompts.ts'
import { InMemoryOnboardingStateStore } from '@neutronai/onboarding/interview/state-store.ts'
import { TranscriptWriter } from '@neutronai/onboarding/interview/transcript.ts'
import { InMemoryConsumedTokens } from '@neutronai/runtime/consumed-tokens-in-memory.ts'
import type {
  ClaimStartTokenJtiInput,
  ConsumedStartToken,
  StartTokenSignupVia,
  VerifyStartTokenInput,
} from '@neutronai/runtime/start-token-types.ts'
import { STUB_PLATFORM } from '@neutronai/runtime/__tests__/stub-platform.ts'

// 2026-05-10 — both telegram and web channels now resolve to the same
// static fallback when the LLM driver is unwired. The legacy
// S1_PROMPT_BODY_WEB / S1_PROMPT_OPTIONS constants are gone; shim
// preserves diff minimization in the legacy assertions.
const S1_PROMPT_BODY_WEB = STATIC_PHASE_SPECS['signup']!.body

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

// Production wire-format audience claim for onboarding start-tokens —
// mirrored locally so the in-process verifier rejects mismatched-aud
// tokens exactly like the Managed verifier does.
const START_TOKEN_AUDIENCE = 'neutron-onboarding-start'

/**
 * Mint a start-token entirely in-process with a local EdDSA key. Carries
 * the production wire shape (single `instance_slug` claim + `signup_via`
 * + `sub` + `aud` + `jti`). No identity service, no signup/ import.
 */
async function issueStartTokenLocal(input: {
  project_slug: string
  user_id: string
  signup_via: StartTokenSignupVia
  signing_key: { kid: string; privateKey: KeyLike }
  ttl_seconds?: number
  now?: () => number
}): Promise<{ token: string; jti: string; expires_at_ms: number }> {
  const now_ms = (input.now ?? (() => Date.now()))()
  const iat_s = Math.floor(now_ms / 1000)
  const exp_s = iat_s + (input.ttl_seconds ?? 600)
  const jti = randomUUID()
  const token = await new SignJWT({
    instance_slug: input.project_slug,
    signup_via: input.signup_via,
  })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid: input.signing_key.kid })
    .setSubject(input.user_id)
    .setIssuedAt(iat_s)
    .setExpirationTime(exp_s)
    .setAudience([START_TOKEN_AUDIENCE])
    .setJti(jti)
    .sign(input.signing_key.privateKey)
  return { token, jti, expires_at_ms: exp_s * 1000 }
}

/**
 * Verify a start-token's signature / audience / expiry / required claims
 * in-process, returning the production `ConsumedStartToken` shape. This is
 * the DI-shaped `VerifyStartTokenFn` the chat-bridge consumes — it does the
 * same checks the Managed verifier does, minus the identity-service key
 * lookup (the test wires its own `resolveKey`).
 */
const verifyStartTokenLocal = async (
  input: VerifyStartTokenInput,
): Promise<ConsumedStartToken> => {
  const now = input.now ?? ((): number => Date.now())
  const parsed: { payload: JWTPayload } = await jwtVerify(
    input.token,
    async (header): Promise<KeyLike> => {
      if (header.alg !== 'EdDSA') throw new Error(`unexpected alg=${header.alg}`)
      const kid = header.kid
      if (typeof kid !== 'string' || kid.length === 0) {
        throw new Error('header.kid required')
      }
      const key = await input.resolveKey(kid)
      if (key === null) throw new Error(`no key for kid=${kid}`)
      return key
    },
    {
      audience: START_TOKEN_AUDIENCE,
      currentDate: new Date(now()),
    },
  )
  const { payload } = parsed
  const expires_at_ms = typeof payload.exp === 'number' ? payload.exp * 1000 : 0
  const jti = typeof payload.jti === 'string' ? payload.jti : ''
  if (jti.length === 0) throw new Error('jti claim required')
  const slug =
    typeof payload['instance_slug'] === 'string' &&
    payload['instance_slug'].length > 0
      ? (payload['instance_slug'] as string)
      : ''
  if (slug.length === 0) throw new Error('instance_slug claim required')
  const user_id = typeof payload.sub === 'string' ? payload.sub : ''
  if (user_id.length === 0) throw new Error('sub claim required')
  const signup_via_raw =
    typeof payload['signup_via'] === 'string'
      ? (payload['signup_via'] as string)
      : ''
  if (signup_via_raw !== 'telegram' && signup_via_raw !== 'web') {
    throw new Error(`signup_via must be telegram|web; got ${signup_via_raw}`)
  }
  return {
    instance_slug: slug,
    project_slug: slug,
    user_id,
    signup_via: signup_via_raw,
    jti,
    expires_at_ms,
  }
}

/** Atomic one-time-use JTI claim — the DI-shaped `ClaimStartTokenJtiFn`. */
const claimStartTokenJtiLocal = async (
  input: ClaimStartTokenJtiInput,
): Promise<void> => {
  const claimed = await input.consumedTokens.claim(input.jti, input.expires_at_ms)
  if (!claimed) throw new Error(`start-token jti=${input.jti} already consumed`)
}

const cleanups: string[] = []
afterEach(() => {
  while (cleanups.length > 0) {
    rmSync(cleanups.pop()!, { recursive: true, force: true })
  }
  delete process.env['NEUTRON_DB_PATH']
  delete process.env['NEUTRON_INSTANCE_SLUG']
  delete process.env['NOTIFY_SOCKET']
})

interface FullStack {
  signupHandle: { port: number; stop: () => Promise<void> }
  gatewayHandle: Awaited<ReturnType<typeof boot>>
  stateStore: InMemoryOnboardingStateStore
  registry: InMemoryWebChatSenderRegistry
  cleanup: () => Promise<void>
  /** Mint a fresh start-token for the test. */
  mintToken(input: {
    project_slug: string
    user_id: string
    signup_via: StartTokenSignupVia
  }): Promise<string>
}

async function bootFullStack(input: { project_slug: string }): Promise<FullStack> {
  const { project_slug } = input
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-s18-e2e-open-'))
  cleanups.push(tmp)
  process.env['NEUTRON_DB_PATH'] = join(tmp, 'owner.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = project_slug
  delete process.env['NOTIFY_SOCKET']

  // Mint a key pair for start-tokens. Production wires through identity's
  // active signing key + JWKS; here we use a single key + an in-memory
  // resolveKey so the test is deterministic.
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true })
  const signing = { kid: 'kid-test', privateKey: privateKey as KeyLike }
  const resolveKey = async (kid: string): Promise<KeyLike | null> =>
    kid === 'kid-test' ? (publicKey as KeyLike) : null

  // Boot the platform-landing process (signup-landing surrogate).
  const signupHandle = await bootSignup({
    port: 0,
    identityOauthUrl: 'https://auth.example/oauth/google/start',
    staticDir: LANDING_DIR,
  })

  // Boot the per-owner gateway with the FULL production wiring for the
  // chat surface.
  const consumedTokens = new InMemoryConsumedTokens()
  const stateStore = new InMemoryOnboardingStateStore()
  const registry = new InMemoryWebChatSenderRegistry()
  const transcriptPath = join(tmp, 'persona', 'onboarding-transcript.jsonl')
  const transcript = new TranscriptWriter({ path: transcriptPath })
  const sentSendBuffer: Array<unknown> = []

  const gatewayHandle = await boot({
    port: 0,
    composer: ({ db, project_slug: bootedSlug }) => {
      const buttonStore = new ButtonStore({ db })
      const engine = new InterviewEngine({
        buttonStore,
        stateStore,
        transcript,
        sendButtonPrompt: buildRoutedSendButtonPrompt({ webRegistry: registry }),
      })
      const bridge = buildWebChatBridge({
        // C2 — start-token auth is injection-only (the lazy signup/
        // dynamic-import fallback was deleted); bind the local impls.
        verifyStartToken: verifyStartTokenLocal,
        claimStartTokenJti: claimStartTokenJtiLocal,
        expected_project_slug: bootedSlug,
        resolveKey,
        consumedTokens,
        engine,
        registry,
      })
      const landing = createLandingServer({
        static_dir: LANDING_DIR,
        bridge,
      })
      return {
        db,
        project_slug: bootedSlug,
        topic_handler: async () => {},
        approval_notifier: { notify: async () => undefined },
        watchdog_notifier: { notify: async () => undefined },
        reminder_dispatcher: { dispatch: async () => undefined },
        heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
        platform: STUB_PLATFORM,
        landing_server: {
          fetch: landing.fetch,
          websocket: landing.websocket,
        },
      }
    },
  })

  return {
    signupHandle,
    gatewayHandle,
    stateStore,
    registry,
    async cleanup() {
      await gatewayHandle.shutdown()
      await signupHandle.stop()
    },
    async mintToken({ project_slug, user_id, signup_via }) {
      const minted = await issueStartTokenLocal({
        project_slug,
        user_id,
        signup_via,
        signing_key: signing,
      })
      // Reference the buffer so unused-var lint doesn't strike.
      sentSendBuffer.push(null)
      return minted.token
    },
  }
}

describe('Sprint 18 — end-to-end chat flow', () => {
  test('signup → /api/v1/sign-up redirect → /chat → /ws/chat → first prompt arrives → state advances', async () => {
    const stack = await bootFullStack({ project_slug: 'alice' })
    try {
      // 1. Platform-landing's /api/v1/sign-up redirects to identity OAuth.
      const signupRes = await fetch(
        `http://127.0.0.1:${stack.signupHandle.port}/api/v1/sign-up?via=web`,
        { redirect: 'manual' },
      )
      expect(signupRes.status).toBe(302)
      const oauthLoc = signupRes.headers.get('location')
      expect(oauthLoc).not.toBeNull()
      const oauthUrl = new URL(oauthLoc!)
      expect(oauthUrl.origin).toBe('https://auth.example')
      expect(oauthUrl.searchParams.get('via')).toBe('web')

      // 2. Simulate the post-signin output: mint a web-typed start-token
      //    for the freshly-provisioned single-owner instance.
      const token = await stack.mintToken({
        project_slug: 'alice',
        user_id: 'u-1',
        signup_via: 'web',
      })

      // 3. The user's browser hits /chat?start=<token> on the per-owner
      //    gateway. /chat itself serves chat.html (no auth side-effect);
      //    the actual token consumption happens at /ws/chat upgrade.
      const chatRes = await fetch(
        `http://127.0.0.1:${stack.gatewayHandle.server.port}/chat?start=${encodeURIComponent(token)}`,
      )
      expect(chatRes.status).toBe(200)
      const chatHtml = await chatRes.text()
      expect(chatHtml).toContain('Neutron')
      expect(chatHtml).toContain('id="log"')

      // Pre-condition: no onboarding_state row yet for this owner.
      const preState = await stack.stateStore.get('alice', 'u-1')
      expect(preState).toBeNull()

      // 4. Open a real WebSocket to /ws/chat?start=<token>. Bun's WebSocket
      //    runtime client uses standard browser shape.
      const wsUrl = `ws://127.0.0.1:${stack.gatewayHandle.server.port}/ws/chat?start=${encodeURIComponent(token)}`
      const ws = new WebSocket(wsUrl)
      const received: Array<{ type: string; body?: string; prompt_id?: string; options?: unknown[] }> = []
      const opened = new Promise<void>((resolve, reject) => {
        ws.addEventListener('open', () => resolve())
        ws.addEventListener('error', (ev) => reject(new Error(`ws error: ${String(ev)}`)))
      })
      const firstMessage = new Promise<unknown>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('first message timeout')), 5_000)
        ws.addEventListener('message', (ev) => {
          const data = typeof ev.data === 'string' ? ev.data : ev.data.toString()
          const parsed = JSON.parse(data) as { type: string; body?: string; prompt_id?: string }
          received.push(parsed)
          // ISSUES #115: a deterministic `agent_typing_start` envelope now
          // precedes the first `agent_message` on EVERY turn (not just the LLM
          // path). Skip typing frames and resolve on the first real prompt.
          if (parsed.type === 'agent_typing_start' || parsed.type === 'agent_typing_stop') return
          clearTimeout(t)
          resolve(parsed)
        })
      })
      await opened
      const first = (await firstMessage) as {
        type: string
        body: string
        prompt_id?: string
        options?: Array<{ label: string; body: string; value: string }>
      }

      // 5. First message is the engine's signup opening prompt. Both
      //    channels resolve to the same static fallback (free-text
      //    persona-discovery question, zero menu options) when the LLM
      //    driver is unwired. See `STATIC_PHASE_SPECS` in
      //    onboarding/interview/phase-prompts.ts.
      expect(first.type).toBe('agent_message')
      expect(first.body).toBe(S1_PROMPT_BODY_WEB)
      expect(first.prompt_id).toBeDefined()
      // Static fallback has zero options — every onboarding turn is
      // free-text by default. The web client's `options` field is
      // omitted when length === 0 (see chat-bridge.ts), so we accept
      // either undefined or an empty array.
      expect(first.options === undefined || first.options.length === 0).toBe(true)

      // 5b. State machine cursor advanced past null → 'signup'.
      const midState = await stack.stateStore.get('alice', 'u-1')
      expect(midState).not.toBeNull()
      expect(midState!.phase).toBe('signup')
      expect(midState!.phase_state['signup_via']).toBe('web')

      // 6. Send a freeform reply. The static signup fallback advances
      //    signup → instance_provisioned (auto-skipped) → import_offered.
      //    The user lands on the import-substrate picker, the first
      //    interactive prompt after signup.
      ws.send(
        JSON.stringify({
          type: 'user_message',
          body: 'Alice',
        }),
      )

      // Wait for the auto-skip walker to chain signup →
      // instance_provisioned → import_offered in a single advance() call.
      const phaseAfter = await waitFor(() => stack.stateStore.get('alice', 'u-1'), (s) => s?.phase === 'ai_substrate_offered', 5_000)
      expect(phaseAfter?.phase).toBe('ai_substrate_offered')

      // 7. Close the socket.
      ws.close()
      // Give the close a moment to propagate so the after-test cleanup
      // doesn't race the close.
      await sleep(50)
    } finally {
      await stack.cleanup()
    }
  })

  // Single-owner auth-scoping: a start-token minted for a DIFFERENT owner
  // slug must NOT authorize this owner's chat socket. Boot cost (real
  // Bun.serve + landing + DB + migrations + engine + WS bridge) gets an
  // explicit 30s budget so CPU contention under parallel `bun test`
  // doesn't false-flake the 401 assertion before fetch() resolves.
  test('/ws/chat with a token minted for a different owner is rejected (401)', async () => {
    const stack = await bootFullStack({ project_slug: 'alice' })
    try {
      const token = await stack.mintToken({
        project_slug: 'bob', // mismatched
        user_id: 'u-1',
        signup_via: 'web',
      })
      const res = await fetch(
        `http://127.0.0.1:${stack.gatewayHandle.server.port}/ws/chat?start=${encodeURIComponent(token)}`,
      )
      expect(res.status).toBe(401)
    } finally {
      await stack.cleanup()
    }
  }, 30_000)

  test('/ws/chat with a telegram-typed token is rejected on the web bridge (401)', async () => {
    const stack = await bootFullStack({ project_slug: 'alice' })
    try {
      const token = await stack.mintToken({
        project_slug: 'alice',
        user_id: 'u-1',
        signup_via: 'telegram',
      })
      const res = await fetch(
        `http://127.0.0.1:${stack.gatewayHandle.server.port}/ws/chat?start=${encodeURIComponent(token)}`,
      )
      expect(res.status).toBe(401)
    } finally {
      await stack.cleanup()
    }
  }, 30_000)
})

async function waitFor<T>(
  fn: () => Promise<T>,
  predicate: (v: T) => boolean,
  timeout_ms: number,
): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < timeout_ms) {
    const v = await fn()
    if (predicate(v)) return v
    await sleep(25)
  }
  throw new Error(`waitFor: predicate not satisfied within ${timeout_ms}ms`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
