/**
 * T10 — welcome-emit-on-fresh-instance-WS-connect regression.
 *
 * Repro contract (per T10 brief):
 *   1. Construct the production composer via `buildLandingStack(...)` (NOT
 *      the hand-rolled sprint18 stack) so the engine, sender registry,
 *      sendButtonPrompt routing, JWT validate path, and `createLandingServer`
 *      are the SAME instances production walks.
 *   2. Boot a real `Bun.serve` against the composer's `{fetch, websocket}`.
 *   3. Mint a real start_token via `signup/start-token.ts:issueStartToken`
 *      against a freshly generated EdDSA key (production-shape token).
 *   4. Open a real WebSocket to the per-instance chat-bridge with the token
 *      in the query string.
 *   5. Assert: server emits an `agent_message` envelope within 5s, body
 *      matches the static signup prompt.
 *   6. Assert: `onboarding_state` row exists with `phase='signup'` and
 *      `active_prompt_id` set.
 *
 * Why this exists: until 2026-05-14 every existing integration test for
 * the chat-bridge surface used either (a) a hand-rolled composer that
 * bypassed `buildLandingStack` (sprint18 e2e) or (b) the
 * `buildLandingStack` factory's `fetch` handler against a `fakeUpgradeServer`
 * that short-circuits the upgrade. Neither caught a regression in the
 * WS upgrade → `engine.start` → `sendButtonPrompt` → `WebChatSenderRegistry.send`
 * chain when wired through the production composer.
 *
 * Forbidden patterns (T10 brief):
 *   - "Test that mocks the WS handler — must use a REAL WebSocket against
 *     the real chat-bridge route."
 *   - "Aspirational claims about 'the engine emits the welcome' without a
 *     test that asserts the agent_message envelope arrives on the WS."
 *
 * This test must remain a real-WebSocket / real-Bun.serve / real-composer
 * walk. Do NOT downgrade it to a fetch-only handler test if the engine
 * surface gets refactored.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateKeyPair, exportJWK, type KeyLike } from 'jose'

import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { JwksCache } from '../../../jwt-validator/validator.ts'
import {
  issueStartToken,
  verifyStartToken,
  claimStartTokenJti,
  buildStartTokenTestPlatform,
} from '@neutronai/runtime/__tests__/start-token-testkit.ts'
import type { PlatformAdapter } from '@neutronai/runtime/platform-adapter.ts'
import { STATIC_PHASE_SPECS } from '../../../onboarding/interview/phase-prompts.ts'
import { SqliteOnboardingStateStore } from '../../../onboarding/interview/sqlite-state-store.ts'
import { ButtonStore } from '../../../channels/button-store.ts'
import { TranscriptWriter } from '../../../onboarding/interview/transcript.ts'
import { InterviewEngine } from '../../../onboarding/interview/engine.ts'
import type { SendButtonPromptFn } from '../../../onboarding/interview/engine.ts'
import type { SlugHistoryShimStore } from '../../http/chat-bridge.ts'
import { buildLandingStack } from '../build-landing-stack.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..')
const REPO_LANDING_DIR = join(REPO_ROOT, 'landing')

const NOOP_SHIM_STORE: SlugHistoryShimStore = { lookup: async () => null }

// C2 OSS-split (2026-06-10) — start-token auth is injection-only now:
// chat-bridge's lazy dynamic-import fallback of the Managed start-token
// module was DELETED (a dynamic import is still an open→managed edge),
// so a stack built without `input.platform` rejects every `?start=`
// token with `reason=start-token-auth-unwired` and the WS never opens.
// Mirror the production Managed composer
// (the Managed provisioning realmode-composer): thread the start-token
// verify/claim primitives through the platform adapter →
// `platform.verifyStartToken` / `platform.claimStartTokenJti`. The Open
// testkit's `buildStartTokenTestPlatform` wires the same seam pair onto
// a Local adapter, reaching the identical bridge auth path without an
// import edge on the Managed shim (ISSUES #219).
function makeStartTokenPlatform(): PlatformAdapter {
  return buildStartTokenTestPlatform({ verifyStartToken, claimStartTokenJti })
}

let workdir: string
let db: ProjectDb

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'neutron-t10-welcome-'))
  const dbPath = join(workdir, 'owner.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  db = ProjectDb.open(dbPath)
  ensureChatHtml(REPO_LANDING_DIR)
})

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true })
})

function ensureChatHtml(staticDir: string): void {
  const target = join(staticDir, 'chat.html')
  if (!existsSync(target)) writeFileSync(target, '<html></html>')
}

async function makeKeysAndJwks(kid: string): Promise<{
  signing: { kid: string; privateKey: KeyLike }
  jwks: JwksCache
}> {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true })
  const pubJwk = await exportJWK(publicKey)
  const jwksBody = { keys: [{ ...pubJwk, kid, alg: 'EdDSA', use: 'sig' }] }
  const fetchImpl = async (): Promise<Response> =>
    new Response(JSON.stringify(jwksBody), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  return {
    signing: { kid, privateKey: privateKey as KeyLike },
    jwks: new JwksCache('https://auth.example.test/.well-known/jwks.json', {
      fetch: fetchImpl,
    }),
  }
}

async function waitFor<T>(
  fn: () => Promise<T>,
  predicate: (v: T) => boolean,
  timeout_ms: number,
): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < timeout_ms) {
    const v = await fn()
    if (predicate(v)) return v
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`waitFor: predicate not satisfied within ${timeout_ms}ms`)
}

interface BootedHarness {
  port: number
  shutdown: () => Promise<void>
}

function bootHarness(
  stack: ReturnType<typeof buildLandingStack>,
): BootedHarness {
  // Bun.serve typing here is loose because the landing module's
  // SocketState is intentionally module-private; the realmode-composer
  // returns the `{ fetch, websocket }` pair from `createLandingServer`,
  // whose `websocket` field is generic over that private type. The cast
  // is safe — Bun.serve treats the websocket handler as opaque per-conn
  // state, and the connection state we set inside the handler doesn't
  // leak out through this test seam.
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req, srv) =>
      stack.fetch(req, srv as unknown as import('bun').Server<unknown>),
    websocket: stack.websocket as unknown as import('bun').WebSocketHandler<unknown>,
  })
  const port = server.port
  if (typeof port !== 'number') {
    throw new Error('bootHarness: Bun.serve did not bind a port')
  }
  return {
    port,
    async shutdown() {
      server.stop(true)
    },
  }
}

test('T10: fresh-instance WS connect emits the signup welcome via the production composer', async () => {
  const project_slug = 'test-' + Math.random().toString(16).slice(2, 10)
  const internal_handle = 't-' + Math.random().toString(16).slice(2, 10)
  const user_id = 'synthetic:e2e:t10-' + Math.random().toString(16).slice(2, 8)

  const { signing, jwks } = await makeKeysAndJwks('k1')
  const issued = await issueStartToken({
    project_slug,
    user_id,
    signup_via: 'web',
    signing_key: signing,
  })

  const stack = buildLandingStack({
    db,
    project_slug,
    owner_home: join(workdir, 'owner-home'),
    jwks,
    static_dir: REPO_LANDING_DIR,
    internal_handle,
    slugHistoryStore: NOOP_SHIM_STORE,
    // C2 — injection-only start-token auth (see makeStartTokenPlatform).
    platform: makeStartTokenPlatform(),
  })

  const harness = bootHarness(stack)
  try {
    // Sanity: /chat 200s (proves the fetch path is wired through Bun.serve).
    const chatRes = await fetch(`http://127.0.0.1:${harness.port}/chat`)
    expect(chatRes.status).toBe(200)

    const wsUrl = `ws://127.0.0.1:${harness.port}/ws/chat?start=${encodeURIComponent(issued.token)}`
    const ws = new WebSocket(wsUrl)
    const received: Array<{ type: string; body?: string; prompt_id?: string }> = []
    const opened = new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve())
      ws.addEventListener('error', (ev) =>
        reject(new Error(`ws error: ${String((ev as Event).type ?? 'unknown')}`)),
      )
    })
    const firstAgentMessage = new Promise<{
      type: string
      body: string
      prompt_id?: string
      options?: Array<{ label: string; body: string; value: string }>
    }>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error('first agent_message timeout (T10 repro)')),
        5_000,
      )
      ws.addEventListener('message', (ev) => {
        const raw = typeof ev.data === 'string' ? ev.data : ev.data.toString()
        let parsed: { type: string; body?: string; prompt_id?: string; options?: unknown }
        try {
          parsed = JSON.parse(raw)
        } catch {
          return
        }
        const entry: { type: string; body?: string; prompt_id?: string } = {
          type: parsed.type,
        }
        if (parsed.body !== undefined) entry.body = parsed.body
        if (parsed.prompt_id !== undefined) entry.prompt_id = parsed.prompt_id
        received.push(entry)
        if (parsed.type === 'agent_message') {
          clearTimeout(t)
          resolve(
            parsed as {
              type: string
              body: string
              prompt_id?: string
              options?: Array<{ label: string; body: string; value: string }>
            },
          )
        }
      })
      ws.addEventListener('close', () => {
        clearTimeout(t)
        reject(
          new Error(
            `ws closed before first agent_message; received=${JSON.stringify(received)}`,
          ),
        )
      })
    })

    await opened
    const first = await firstAgentMessage

    expect(first.type).toBe('agent_message')
    expect(first.body).toBe(STATIC_PHASE_SPECS['signup']!.body)
    expect(typeof first.prompt_id).toBe('string')
    expect((first.prompt_id ?? '').length).toBeGreaterThan(0)

    // Assert: onboarding_state row exists with phase='signup' AND
    // active_prompt_id is set (proves the engine ran the full
    // emit + upsert before sendButtonPrompt's WS write).
    const stateStore = new SqliteOnboardingStateStore({ db })
    const row = await waitFor(
      () => stateStore.get(project_slug, user_id),
      (s) => s !== null && s.phase === 'signup',
      2_000,
    )
    expect(row).not.toBeNull()
    expect(row!.phase).toBe('signup')
    expect(typeof row!.phase_state['active_prompt_id']).toBe('string')
    expect((row!.phase_state['active_prompt_id'] as string).length).toBeGreaterThan(0)
    expect(row!.phase_state['signup_via']).toBe('web')
    expect(row!.phase_state['user_id']).toBe(user_id)

    ws.close()
    await new Promise((r) => setTimeout(r, 50))
  } finally {
    await harness.shutdown()
  }
})

// T10 silent-drop regression — when `sendButtonPrompt` returns
// `was_new=false` (no live sender for topic_id, channel misroute, or
// closed-WS race), the engine MUST leave `delivered_at = null` on the
// button_prompts row so the reconnect re-emit branch picks it up.
//
// Pre-T10 the engine called `markDelivered` regardless of the routed-
// sender result. On synthetic-auth instances this materialised as "WS
// upgrade succeeds, banner shows connected, #log stays empty" because:
//   1. engine.start emitted a fresh prompt, button_prompts row landed
//      with delivered_at=null on insert.
//   2. sendButtonPrompt routed to web → registry.send returned false
//      (no sender for the topic_id, e.g. the close handler had already
//      unregistered after the WS dropped mid-startSession).
//   3. Engine then called markDelivered → delivered_at flipped to non-
//      null even though the user never saw the bubble.
//   4. On reconnect, engine.start's "active_prompt_id set but
//      unresolved" branch SAW the prompt as delivered (peek's
//      meta.resolved_at was still null but the row was delivered) and
//      took the early-return path with NO re-emit.
//   5. User stranded on an empty chat forever — exactly the T10 repro.
//
// This test pins the post-T10 contract: `was_new=false` from the
// sender leaves the row's delivered_at = null AND the engine's return
// surfaces `was_new=false` so the bridge can act on the failure.
test('T10: sendButtonPrompt was_new=false leaves button_prompts row delivered_at=null (silent-drop fix)', async () => {
  // Build an InterviewEngine with a stub sendButtonPrompt that always
  // returns `was_new=false` (simulates "registry had no sender" for
  // the welcome envelope's topic_id — the close-during-startSession
  // race or unknown-channel-prefix). The test driver is intentionally
  // synthetic so the assertion is on engine behavior, not on the
  // chat-bridge wiring (the integration test above already pins that).
  const project_slug = 'silent-drop-' + Math.random().toString(16).slice(2, 8)
  const owner_home = join(workdir, 'owner-silent-drop')

  const sendCalls: Array<{ topic_id: string; prompt_id: string }> = []
  const sendButtonPrompt: SendButtonPromptFn = async ({ topic_id, prompt }) => {
    sendCalls.push({ topic_id, prompt_id: prompt.prompt_id })
    return { message_id: prompt.prompt_id, was_new: false }
  }
  const buttonStore = new ButtonStore({ db })
  const stateStore = new SqliteOnboardingStateStore({ db })
  const transcript = new TranscriptWriter({
    path: join(owner_home, 'persona', 'onboarding-transcript.jsonl'),
  })
  const engine = new InterviewEngine({
    buttonStore,
    stateStore,
    transcript,
    sendButtonPrompt,
  })

  const start_result = await engine.start({
    project_slug,
    topic_id: 'web:synthetic:e2e:silent-drop',
    user_id: 'synthetic:e2e:silent-drop',
    signup_via: 'web',
  })

  // sendButtonPrompt fired once with the static signup body.
  expect(sendCalls.length).toBe(1)
  expect(sendCalls[0]!.prompt_id).toBe(start_result.prompt_id)

  // start_result.was_new must surface `false` so the bridge sees the
  // "didn't reach a live sender" outcome — pre-T10 this collapsed to
  // `was_new = true` because the engine clobbered it after marking
  // delivered.
  expect(start_result.was_new).toBe(false)

  // The button_prompts row exists + has delivered_at = null. The
  // ButtonStore.deliveredAt method returns null for a row that has
  // never been marked delivered, which is the post-T10 invariant when
  // the send did not actually reach a sender.
  const delivered_at = await buttonStore.deliveredAt(start_result.prompt_id)
  expect(delivered_at).toBeNull()

  // onboarding_state row exists at phase='signup' with active_prompt_id
  // set — engine still recorded the emit so the reconnect re-emit
  // branch can pick it up.
  const row = await stateStore.get(project_slug, 'synthetic:e2e:silent-drop')
  expect(row).not.toBeNull()
  expect(row!.phase).toBe('signup')
  expect(row!.phase_state['active_prompt_id']).toBe(start_result.prompt_id)

  // Codex r1 P2 — the transcript MUST NOT contain an agent turn for
  // the undelivered welcome. Pre-Codex-r1-P2 fix the engine appended
  // the line on `emit.was_new` regardless of delivery, which would (a)
  // lie to the operator inspecting the transcript and (b) cause the
  // reconnect re-emit branch's own transcript append to duplicate the
  // line. Post-fix, the transcript stays empty until a real delivery
  // lands.
  const { readFileSync, existsSync: fileExists } = await import('node:fs')
  const transcript_path = join(owner_home, 'persona', 'onboarding-transcript.jsonl')
  const transcript_body = fileExists(transcript_path)
    ? readFileSync(transcript_path, 'utf8')
    : ''
  // TranscriptWriter touches the file on construction, so existence is
  // expected; the body is what we check.
  expect(transcript_body.includes(`"button_prompt_id":"${start_result.prompt_id}"`)).toBe(false)
})

// T10 forge-fix r2 (Codex r2 P2) — reconnect resend paths must also
// leave delivered_at = null when the routed sender reports
// `was_new=false`. Pre-fix the unresolved-prompt re-emit branch in
// `engine.start()` (used when an active_prompt_id is set but the user
// hasn't acted) called `markDelivered` unconditionally after
// `sendButtonPrompt` returned. A reconnect that lost its sender
// mid-resend would flip delivered_at non-null and the NEXT start()
// would skip the prompt forever — recreating the empty-chat strand
// T10 is closing.
//
// Sequence under test (single-process, no real WS — synthetic stub):
//   1. engine.start() #1 succeeds with delivered sender → row at
//      phase='signup', active_prompt_id set, delivered_at set.
//   2. Reset delivered_at to null (simulating "the first emit hit a
//      transient send failure and the unresolved branch is now the
//      recovery path").
//   3. engine.start() #2 with a sender that returns `was_new=false`
//      (simulates closed-WS race during the resend) — must NOT
//      flip delivered_at back to non-null.
test('T10 forge-fix r2: unresolved-prompt re-emit branch leaves delivered_at=null when resend is undelivered', async () => {
  const project_slug = 'reemit-undeliv-' + Math.random().toString(16).slice(2, 8)
  const owner_home = join(workdir, 'owner-reemit-undeliv')

  let nextSendResult: { was_new: boolean } = { was_new: true }
  const sendButtonPrompt: SendButtonPromptFn = async ({ prompt }) => {
    return { message_id: prompt.prompt_id, was_new: nextSendResult.was_new }
  }
  const buttonStore = new ButtonStore({ db })
  const stateStore = new SqliteOnboardingStateStore({ db })
  const transcript = new TranscriptWriter({
    path: join(owner_home, 'persona', 'onboarding-transcript.jsonl'),
  })
  const engine = new InterviewEngine({
    buttonStore,
    stateStore,
    transcript,
    sendButtonPrompt,
  })

  // Step 1 — fresh emit lands delivered. `was_new=true` triggers the
  // fresh-emit happy path: markDelivered runs, delivered_at is set,
  // transcript line lands.
  nextSendResult = { was_new: true }
  const first = await engine.start({
    project_slug,
    topic_id: 'web:synthetic:e2e:reemit-undeliv',
    user_id: 'synthetic:e2e:reemit-undeliv',
    signup_via: 'web',
  })
  expect(first.was_new).toBe(true)
  expect(await buttonStore.deliveredAt(first.prompt_id)).not.toBeNull()

  // Set up the recovery scenario: reset delivered_at to null on the
  // existing row so the next engine.start() walks the unresolved-prompt
  // re-emit branch instead of the early-return-on-delivered path.
  db.raw().run(
    'UPDATE button_prompts SET delivered_at = NULL WHERE prompt_id = ?',
    [first.prompt_id],
  )

  // Bump the row's phase off 'signup' so engine.start() enters the
  // "existing.phase !== 'signup'" branch (line 1175) where the
  // unresolved-prompt re-emit lives. Same shape as a post-rename or
  // post-skip resume against an unresolved active_prompt_id.
  await stateStore.upsert({
    project_slug,
    user_id: 'synthetic:e2e:reemit-undeliv',
    phase: 'instance_provisioned',
    phase_state_patch: { active_prompt_id: first.prompt_id },
    advanced_at: Date.now(),
  })

  // Step 2 — reconnect resend: sender reports `was_new=false`
  // (simulates closed-WS race during the resend). Pre-Codex-r2-P2 fix
  // this branch would have called markDelivered unconditionally; the
  // post-fix invariant is that delivered_at stays null.
  nextSendResult = { was_new: false }
  await engine.start({
    project_slug,
    topic_id: 'web:synthetic:e2e:reemit-undeliv',
    user_id: 'synthetic:e2e:reemit-undeliv',
    signup_via: 'web',
  })

  // Critical assertion: delivered_at is STILL null after the
  // undelivered resend. A future reconnect with a live sender can now
  // pick the prompt up and deliver it.
  expect(await buttonStore.deliveredAt(first.prompt_id)).toBeNull()

  // Step 3 — verify the recovery path is reachable: when the next
  // resend reports `was_new=true`, the row finally flips to delivered.
  nextSendResult = { was_new: true }
  await engine.start({
    project_slug,
    topic_id: 'web:synthetic:e2e:reemit-undeliv',
    user_id: 'synthetic:e2e:reemit-undeliv',
    signup_via: 'web',
  })
  expect(await buttonStore.deliveredAt(first.prompt_id)).not.toBeNull()
})

// T10 forge-fix r2 (Codex r2 P2) — duplicate-start `reuseActivePrompt`
// path must also leave delivered_at = null on an undelivered resend.
// Walks the SIGNUP-phase duplicate-start branch (engine.start() called
// twice for the same fresh instance), exercising the `reuseActivePrompt`
// private method via the public engine surface.
test('T10 forge-fix r2: reuseActivePrompt leaves delivered_at=null when resend is undelivered', async () => {
  const project_slug = 'reuse-undeliv-' + Math.random().toString(16).slice(2, 8)
  const owner_home = join(workdir, 'owner-reuse-undeliv')

  let nextSendResult: { was_new: boolean } = { was_new: false }
  const sendButtonPrompt: SendButtonPromptFn = async ({ prompt }) => {
    return { message_id: prompt.prompt_id, was_new: nextSendResult.was_new }
  }
  const buttonStore = new ButtonStore({ db })
  const stateStore = new SqliteOnboardingStateStore({ db })
  const transcript = new TranscriptWriter({
    path: join(owner_home, 'persona', 'onboarding-transcript.jsonl'),
  })
  const engine = new InterviewEngine({
    buttonStore,
    stateStore,
    transcript,
    sendButtonPrompt,
  })

  // First start — fresh emit, sender reports undelivered. delivered_at
  // stays null (the existing T10 fresh-emit fix).
  nextSendResult = { was_new: false }
  const first = await engine.start({
    project_slug,
    topic_id: 'web:synthetic:e2e:reuse-undeliv',
    user_id: 'synthetic:e2e:reuse-undeliv',
    signup_via: 'web',
  })
  expect(first.was_new).toBe(false)
  expect(await buttonStore.deliveredAt(first.prompt_id)).toBeNull()

  // Duplicate start (same instance, still at phase='signup' with
  // active_prompt_id set + delivered_at=null) → walks reuseActivePrompt.
  // The sender STILL reports undelivered (close-during-reconnect race).
  // Codex r2 P2 invariant: delivered_at remains null.
  nextSendResult = { was_new: false }
  await engine.start({
    project_slug,
    topic_id: 'web:synthetic:e2e:reuse-undeliv',
    user_id: 'synthetic:e2e:reuse-undeliv',
    signup_via: 'web',
  })
  expect(await buttonStore.deliveredAt(first.prompt_id)).toBeNull()

  // Recovery: when the next resend reports delivered, the row finally
  // flips. Confirms the duplicate-start path can recover.
  nextSendResult = { was_new: true }
  await engine.start({
    project_slug,
    topic_id: 'web:synthetic:e2e:reuse-undeliv',
    user_id: 'synthetic:e2e:reuse-undeliv',
    signup_via: 'web',
  })
  expect(await buttonStore.deliveredAt(first.prompt_id)).not.toBeNull()
})

